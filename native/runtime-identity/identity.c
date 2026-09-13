#if defined(__linux__) && !defined(_GNU_SOURCE)
#define _GNU_SOURCE
#endif

#include <node_api.h>

#include <errno.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdbool.h>
#include <string.h>

#if defined(_WIN32)
#include <windows.h>
#include "windows-file-security.h"
#include <wchar.h>
#else
#if !defined(_WIN32)
#include <dirent.h>
#endif
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__linux__)
#include <sys/syscall.h>
#endif
#if defined(__APPLE__)
#include <libproc.h>
#include <limits.h>
#include <sys/sysctl.h>
#else
#include <limits.h>
#endif
#endif

#define IDENTITY_CONTRACT_VERSION 1
#define RUNTIME_FILE_SECURITY_CONTRACT_VERSION 2
#define MAX_IDENTITY_STRING 16384u
#define MAX_NATIVE_MESSAGE 1024u
#define MAX_PRIVATE_FILE_BYTES (16u * 1024u * 1024u)

enum observation_code {
  OBSERVATION_NOT_FOUND = 1,
  OBSERVATION_ACCESS_DENIED = 2,
  OBSERVATION_NATIVE_ERROR = 3
};

typedef struct {
  int ok;
  int code;
  uint32_t pid;
  char boot_id[MAX_IDENTITY_STRING];
  char started_at[MAX_IDENTITY_STRING];
  char executable_path[MAX_IDENTITY_STRING];
  char message[MAX_NATIVE_MESSAGE];
} native_observation;

typedef struct {
  int ok;
  int code;
  char message[MAX_NATIVE_MESSAGE];
  unsigned char *bytes;
  size_t byte_count;
#if defined(_WIN32)
  char volume_serial[32];
  char file_id[64];
#else
  char device[32];
  char inode[32];
#endif
} private_file_observation;

static int copy_bounded(char *destination, size_t capacity, const char *source, size_t length) {
  size_t index;
  if (destination == NULL || source == NULL || capacity == 0 || length >= capacity) return 0;
  for (index = 0; index < length; index++) {
    if (source[index] == '\0') return 0;
    destination[index] = source[index];
  }
  destination[length] = '\0';
  return 1;
}

static void set_message(char *destination, size_t capacity, const char *message) {
  size_t length;
  if (destination == NULL || capacity == 0) return;
  if (message == NULL) message = "native observation failed";
  length = strlen(message);
  if (!copy_bounded(destination, capacity, message, length)) {
    (void)copy_bounded(destination, capacity, "native error", strlen("native error"));
  }
}

static void set_native_error(native_observation *result, int code, const char *message) {
  if (result == NULL) return;
  result->ok = 0;
  result->code = code;
  set_message(result->message, sizeof(result->message), message);
}

static void set_private_error(private_file_observation *result, int code, const char *message) {
  if (result == NULL) return;
  result->ok = 0;
  result->code = code;
  set_message(result->message, sizeof(result->message), message);
}

#if !defined(_WIN32)
static int classify_access_errno(int error_number) {
  return error_number == EACCES || error_number == EPERM ? OBSERVATION_ACCESS_DENIED : OBSERVATION_NATIVE_ERROR;
}

static int classify_process_lookup_errno(int error_number) {
  if (error_number == ENOENT || error_number == ESRCH || error_number == ENOTDIR) return OBSERVATION_NOT_FOUND;
  return classify_access_errno(error_number);
}

static int classify_private_file_errno(int error_number) {
  if (error_number == ENOENT || error_number == ENOTDIR) return OBSERVATION_NOT_FOUND;
  return classify_access_errno(error_number);
}

static void set_errno_error(native_observation *result, int error_number, const char *operation) {
  char message[MAX_NATIVE_MESSAGE];
  int written = snprintf(message, sizeof(message), "%s: %s", operation, strerror(error_number));
  if (written < 0 || (size_t)written >= sizeof(message)) set_message(message, sizeof(message), operation);
  set_native_error(result, classify_access_errno(error_number), message);
}

static void set_process_lookup_errno_error(native_observation *result, int error_number, const char *operation) {
  char message[MAX_NATIVE_MESSAGE];
  int written = snprintf(message, sizeof(message), "%s: %s", operation, strerror(error_number));
  if (written < 0 || (size_t)written >= sizeof(message)) set_message(message, sizeof(message), operation);
  set_native_error(result, classify_process_lookup_errno(error_number), message);
}

static void set_private_errno_error(private_file_observation *result, int error_number, const char *operation) {
  char message[MAX_NATIVE_MESSAGE];
  int written = snprintf(message, sizeof(message), "%s: %s", operation, strerror(error_number));
  if (written < 0 || (size_t)written >= sizeof(message)) set_message(message, sizeof(message), operation);
  set_private_error(result, classify_private_file_errno(error_number), message);
}
#endif

static int make_string(napi_env env, const char *value, napi_value *result) {
  if (value == NULL || result == NULL) return 0;
  return napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, result) == napi_ok;
}

static int set_string_property(napi_env env, napi_value object, const char *name, const char *value) {
  napi_value property;
  if (!make_string(env, value, &property)) return 0;
  return napi_set_named_property(env, object, name, property) == napi_ok;
}

static int set_uint32_property(napi_env env, napi_value object, const char *name, uint32_t value) {
  napi_value property;
  if (napi_create_uint32(env, value, &property) != napi_ok) return 0;
  return napi_set_named_property(env, object, name, property) == napi_ok;
}

static int set_boolean_property(napi_env env, napi_value object, const char *name, int value);
static napi_value make_observation_result(napi_env env, const native_observation *observation) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  if (observation->ok) {
    if (!set_boolean_property(env, result, "ok", 1) ||
        !set_uint32_property(env, result, "pid", observation->pid) ||
        !set_string_property(env, result, "bootId", observation->boot_id) ||
        !set_string_property(env, result, "startedAt", observation->started_at) ||
        !set_string_property(env, result, "executablePath", observation->executable_path)) return NULL;
  } else {
    const char *code = observation->code == OBSERVATION_NOT_FOUND ? "not-found" :
      observation->code == OBSERVATION_ACCESS_DENIED ? "access-denied" : "native-error";
    if (!set_boolean_property(env, result, "ok", 0) ||
        !set_string_property(env, result, "code", code) ||
        !set_string_property(env, result, "message", observation->message)) return NULL;
  }
  return result;
}

static int set_boolean_property(napi_env env, napi_value object, const char *name, int value) {
  napi_value property;
  if (napi_get_boolean(env, value != 0, &property) != napi_ok) return 0;
  return napi_set_named_property(env, object, name, property) == napi_ok;
}

static napi_value make_private_result(napi_env env, const private_file_observation *observation) {
  napi_value result;
  napi_value bytes;
  napi_value identity;
  if (napi_create_object(env, &result) != napi_ok) return NULL;
  if (!observation->ok) {
    const char *code = observation->code == OBSERVATION_NOT_FOUND ? "not-found" :
      observation->code == OBSERVATION_ACCESS_DENIED ? "access-denied" : "native-error";
    if (!set_boolean_property(env, result, "ok", 0) ||
        !set_string_property(env, result, "code", code) ||
        !set_string_property(env, result, "message", observation->message)) return NULL;
    return result;
  }
  if (!set_boolean_property(env, result, "ok", 1)) return NULL;
  if (napi_create_buffer_copy(env, observation->byte_count, observation->bytes, NULL, &bytes) != napi_ok) return NULL;
  if (napi_set_named_property(env, result, "bytes", bytes) != napi_ok) return NULL;
  if (napi_create_object(env, &identity) != napi_ok) return NULL;
#if defined(_WIN32)
  if (!set_string_property(env, identity, "platform", "win32") ||
      !set_string_property(env, identity, "volumeSerial", observation->volume_serial) ||
      !set_string_property(env, identity, "fileId", observation->file_id)) return NULL;
#else
  if (!set_string_property(env, identity, "platform", "posix") ||
      !set_string_property(env, identity, "device", observation->device) ||
      !set_string_property(env, identity, "inode", observation->inode)) return NULL;
#endif
  if (napi_set_named_property(env, result, "fileIdentity", identity) != napi_ok) return NULL;
  return result;
}

static napi_value make_rename_result(napi_env env, int ok, const char *code, const char *message) {
  napi_value result;
  if (napi_create_object(env, &result) != napi_ok || !set_boolean_property(env, result, "ok", ok)) return NULL;
  if (!ok && (!set_string_property(env, result, "code", code) || !set_string_property(env, result, "message", message))) return NULL;
  return result;
}

static const char *rename_error_code(int error_number) {
  if (error_number == EEXIST || error_number == ENOTEMPTY) return "destination-exists";
  if (error_number == ENOENT || error_number == ENOTDIR) return "not-found";
  if (error_number == EACCES || error_number == EPERM) return "access-denied";
  return "native-error";
}

#if defined(__linux__) || defined(__APPLE__)
static int valid_boot_uuid(const char *value, size_t length) {
  size_t index;
  if (length != 36) return 0;
  for (index = 0; index < length; index++) {
    int hexadecimal = (value[index] >= '0' && value[index] <= '9') ||
      (value[index] >= 'a' && value[index] <= 'f') ||
      (value[index] >= 'A' && value[index] <= 'F');
    if ((index == 8 || index == 13 || index == 18 || index == 23) ? value[index] != '-' : !hexadecimal) return 0;
  }
  return 1;
}
#endif

#if defined(__linux__)
static int read_limited_file(const char *path, char *buffer, size_t capacity, size_t *length, int *error_number) {
  int descriptor;
  ssize_t count;
  size_t total = 0;
  if (path == NULL || buffer == NULL || capacity < 2 || length == NULL) return 0;
  descriptor = open(path, O_RDONLY | O_CLOEXEC);
  if (descriptor < 0) {
    if (error_number != NULL) *error_number = errno;
    return 0;
  }
  for (;;) {
    count = read(descriptor, buffer + total, capacity - total);
    if (count < 0) {
      if (error_number != NULL) *error_number = errno;
      (void)close(descriptor);
      return 0;
    }
    if (count == 0) break;
    total += (size_t)count;
    if (total == capacity) {
      (void)close(descriptor);
      if (error_number != NULL) *error_number = EOVERFLOW;
      return 0;
    }
  }
  (void)close(descriptor);
  buffer[total] = '\0';
  *length = total;
  return 1;
}

static int valid_decimal_token(const char *value, size_t length) {
  size_t index;
  if (value == NULL || length == 0 || length >= MAX_IDENTITY_STRING) return 0;
  for (index = 0; index < length; index++) {
    if (value[index] < '0' || value[index] > '9') return 0;
  }
  return 1;
}

typedef struct {
  uint64_t pid;
  char state;
  char started_at[MAX_IDENTITY_STRING];
} linux_stat_identity;

static int parse_linux_stat(const char *text, size_t length, linux_stat_identity *identity) {
  const char *open_paren;
  const char *close_paren;
  const char *cursor;
  const char *token_start;
  const char *token_end;
  char pid_buffer[32];
  char *end_pointer;
  unsigned long long parsed_pid;
  int field;
  size_t token_length;
  if (text == NULL || identity == NULL || length == 0) return 0;
  open_paren = strchr(text, '(');
  close_paren = strrchr(text, ')');
  if (open_paren == NULL || close_paren == NULL || close_paren <= open_paren) return 0;
  token_length = (size_t)(open_paren - text);
  while (token_length > 0 && (text[token_length - 1] == ' ' || text[token_length - 1] == '\t')) token_length--;
  if (!copy_bounded(pid_buffer, sizeof(pid_buffer), text, token_length)) return 0;
  errno = 0;
  parsed_pid = strtoull(pid_buffer, &end_pointer, 10);
  if (errno != 0 || end_pointer == pid_buffer || *end_pointer != '\0' || parsed_pid == 0) return 0;
  identity->pid = (uint64_t)parsed_pid;
  cursor = close_paren + 1;
  while (*cursor == ' ' || *cursor == '\t') cursor++;
  if (*cursor == '\0' || *cursor == 'Z' || *cursor == 'X' || *cursor == 'x') {
    identity->state = *cursor;
    return 1;
  }
  identity->state = *cursor;
  cursor++;
  for (field = 4; field <= 22; field++) {
    while (*cursor == ' ' || *cursor == '\t') cursor++;
    if (*cursor == '\0') return 0;
    token_start = cursor;
    while (*cursor != '\0' && *cursor != ' ' && *cursor != '\t') cursor++;
    token_end = cursor;
    if (field == 22) {
      token_length = (size_t)(token_end - token_start);
      if (!valid_decimal_token(token_start, token_length) || !copy_bounded(identity->started_at, sizeof(identity->started_at), token_start, token_length)) return 0;
    }
  }
  return identity->started_at[0] != '\0';
}


static int read_linux_boot_id(char *destination, size_t capacity, native_observation *result) {
  char buffer[128];
  size_t length;
  int error_number = 0;
  if (!read_limited_file("/proc/sys/kernel/random/boot_id", buffer, sizeof(buffer), &length, &error_number)) {
    set_errno_error(result, error_number, "read boot id");
    return 0;
  }
  while (length > 0 && (buffer[length - 1] == '\n' || buffer[length - 1] == '\r' || buffer[length - 1] == ' ' || buffer[length - 1] == '\t')) length--;
  if (!valid_boot_uuid(buffer, length) || !copy_bounded(destination, capacity, buffer, length)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "boot id was malformed");
    return 0;
  }
  return 1;
}

static int read_linux_stat(uint64_t pid, linux_stat_identity *identity, native_observation *result) {
  char path[64];
  char buffer[65536];
  size_t length;
  int error_number = 0;
  int written = snprintf(path, sizeof(path), "/proc/%" PRIu64 "/stat", pid);
  if (written < 0 || (size_t)written >= sizeof(path)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process stat path was too long");
    return 0;
  }
  if (!read_limited_file(path, buffer, sizeof(buffer), &length, &error_number)) {
    set_process_lookup_errno_error(result, error_number, "read process stat");
    return 0;
  }
  if (!parse_linux_stat(buffer, length, identity)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process stat was malformed");
    return 0;
  }
  if (identity->state == 'Z' || identity->state == 'X' || identity->state == 'x' || identity->state == '\0') {
    set_native_error(result, OBSERVATION_NOT_FOUND, "process is not running");
    return 0;
  }
  return 1;
}

static int read_linux_executable(uint64_t pid, char *destination, size_t capacity, native_observation *result) {
  char path[64];
  char executable[PATH_MAX + 1];
  ssize_t length;
  int written = snprintf(path, sizeof(path), "/proc/%" PRIu64 "/exe", pid);
  if (written < 0 || (size_t)written >= sizeof(path)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "executable path was too long");
    return 0;
  }
  length = readlink(path, executable, sizeof(executable) - 1);
  if (length < 0) {
    set_errno_error(result, errno, "read executable path");
    return 0;
  }
  if ((size_t)length >= sizeof(executable) - 1 || !copy_bounded(destination, capacity, executable, (size_t)length)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "executable path was truncated");
    return 0;
  }
  return 1;
}

static void read_process_identity_posix_linux(uint64_t pid, native_observation *result) {
  linux_stat_identity first;
  linux_stat_identity second;
  if (pid > (uint64_t)INT_MAX) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "PID is outside the Linux range");
    return;
  }
  if (!read_linux_boot_id(result->boot_id, sizeof(result->boot_id), result)) return;
  if (!read_linux_stat(pid, &first, result)) return;
  if (first.pid != pid) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process stat PID did not match request");
    return;
  }
  if (!read_linux_executable(pid, result->executable_path, sizeof(result->executable_path), result)) return;
  if (!read_linux_stat(pid, &second, result)) return;
  if (first.pid != second.pid || first.state != second.state || strcmp(first.started_at, second.started_at) != 0) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process changed while being observed");
    return;
  }
  if (!copy_bounded(result->started_at, sizeof(result->started_at), first.started_at, strlen(first.started_at))) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process start time was malformed");
    return;
  }
  result->ok = 1;
}
#endif

#if defined(__APPLE__)
static int read_macos_boot_id(char *destination, size_t capacity, native_observation *result) {
  char buffer[128];
  size_t length = sizeof(buffer);
  if (sysctlbyname("kern.bootsessionuuid", buffer, &length, NULL, 0) != 0) {
    set_errno_error(result, errno, "read boot session UUID");
    return 0;
  }
  if (length > 0 && buffer[length - 1] == '\0') length--;
  if (!valid_boot_uuid(buffer, length) || !copy_bounded(destination, capacity, buffer, length)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "boot session UUID was malformed");
    return 0;
  }
  return 1;
}

typedef struct {
  struct kinfo_proc process;
  int present;
} mac_process_identity;

static int read_macos_process(pid_t pid, mac_process_identity *identity, native_observation *result) {
  int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
  size_t length = sizeof(identity->process);
  if (sysctl(mib, 4, &identity->process, &length, NULL, 0) != 0) {
    set_process_lookup_errno_error(result, errno, "read process information");
    return 0;
  }
  if (length == 0) {
    set_native_error(result, OBSERVATION_NOT_FOUND, "process was not found");
    return 0;
  }
  if (length < sizeof(identity->process) || identity->process.kp_proc.p_pid != pid) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process information was malformed");
    return 0;
  }
  identity->present = identity->process.kp_proc.p_stat != SZOMB;
  if (!identity->present) {
    set_native_error(result, OBSERVATION_NOT_FOUND, "process is not running");
    return 0;
  }
  return 1;
}

static int macos_start_time(const struct timeval *value, char *destination, size_t capacity) {
  unsigned long long seconds;
  unsigned long long microseconds;
  unsigned long long total;
  int written;
  if (value == NULL || value->tv_sec < 0 || value->tv_usec < 0 || value->tv_usec >= 1000000) return 0;
  seconds = (unsigned long long)value->tv_sec;
  microseconds = (unsigned long long)value->tv_usec;
  total = seconds * 1000000ULL + microseconds;
  written = snprintf(destination, capacity, "%llu", total);
  return written > 0 && (size_t)written < capacity;
}

static int read_macos_executable(pid_t pid, char *destination, size_t capacity, native_observation *result) {
  char path[PROC_PIDPATHINFO_MAXSIZE];
  int length = proc_pidpath(pid, path, sizeof(path));
  if (length <= 0) {
    set_errno_error(result, errno == 0 ? ESRCH : errno, "read executable path");
    return 0;
  }
  if ((size_t)length >= sizeof(path) || !copy_bounded(destination, capacity, path, (size_t)length)) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "executable path was truncated");
    return 0;
  }
  return 1;
}

static void read_process_identity_posix_macos(uint64_t pid, native_observation *result) {
  mac_process_identity first;
  mac_process_identity second;
  if (pid > (uint64_t)INT_MAX) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "PID is outside the macOS range");
    return;
  }
  if (!read_macos_boot_id(result->boot_id, sizeof(result->boot_id), result)) return;
  if (!read_macos_process((pid_t)pid, &first, result)) return;
  if (!macos_start_time(&first.process.kp_proc.p_starttime, result->started_at, sizeof(result->started_at))) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process start time was malformed");
    return;
  }
  if (!read_macos_executable((pid_t)pid, result->executable_path, sizeof(result->executable_path), result)) return;
  if (!read_macos_process((pid_t)pid, &second, result)) return;
  if (first.process.kp_proc.p_pid != second.process.kp_proc.p_pid ||
      first.process.kp_proc.p_stat != second.process.kp_proc.p_stat ||
      first.process.kp_proc.p_starttime.tv_sec != second.process.kp_proc.p_starttime.tv_sec ||
      first.process.kp_proc.p_starttime.tv_usec != second.process.kp_proc.p_starttime.tv_usec) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "process changed while being observed");
    return;
  }
  result->ok = 1;
}
#endif

#if defined(_WIN32)
static int classify_windows_error(DWORD error_number, int target_lookup) {
  if (target_lookup && error_number == ERROR_INVALID_PARAMETER) return OBSERVATION_NOT_FOUND;
  return error_number == ERROR_ACCESS_DENIED ? OBSERVATION_ACCESS_DENIED : OBSERVATION_NATIVE_ERROR;
}

static void set_windows_error(native_observation *result, DWORD error_number, const char *operation, int target_lookup) {
  char message[MAX_NATIVE_MESSAGE];
  int written = snprintf(message, sizeof(message), "%s (error %lu)", operation, (unsigned long)error_number);
  if (written < 0 || (size_t)written >= sizeof(message)) set_message(message, sizeof(message), operation);
  set_native_error(result, classify_windows_error(error_number, target_lookup), message);
}

static int windows_process_running(HANDLE process, native_observation *result) {
  DWORD state = WaitForSingleObject(process, 0);
  if (state == WAIT_TIMEOUT) return 1;
  if (state == WAIT_OBJECT_0) {
    set_native_error(result, OBSERVATION_NOT_FOUND, "process is not running");
    return 0;
  }
  set_windows_error(result, GetLastError(), "check process state", 0);
  return 0;
}

static int windows_creation_time(HANDLE process, char *destination, size_t capacity) {
  FILETIME creation;
  FILETIME exit_time;
  FILETIME kernel_time;
  FILETIME user_time;
  ULARGE_INTEGER value;
  int written;
  if (!GetProcessTimes(process, &creation, &exit_time, &kernel_time, &user_time)) return 0;
  value.LowPart = creation.dwLowDateTime;
  value.HighPart = creation.dwHighDateTime;
  written = snprintf(destination, capacity, "%llu", (unsigned long long)value.QuadPart);
  return written > 0 && (size_t)written < capacity;
}

static int windows_executable(HANDLE process, char *destination, size_t capacity) {
  WCHAR wide_path[32768];
  DWORD wide_length = (DWORD)(sizeof(wide_path) / sizeof(wide_path[0]));
  int byte_length;
  if (!QueryFullProcessImageNameW(process, 0, wide_path, &wide_length)) return 0;
  if (wide_length == 0 || wide_length >= (DWORD)(sizeof(wide_path) / sizeof(wide_path[0]))) return 0;
  byte_length = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, wide_path, (int)wide_length, destination, (int)capacity - 1, NULL, NULL);
  if (byte_length <= 0 || (size_t)byte_length >= capacity) return 0;
  destination[byte_length] = '\0';
  return 1;
}

static void read_process_identity_windows(uint64_t pid, native_observation *result) {
  HANDLE process;
  if (pid == 0 || pid > UINT32_MAX) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "PID is outside the Windows range");
    return;
  }
  process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, (DWORD)pid);
  if (process == NULL) {
    set_windows_error(result, GetLastError(), "open process", 1);
    return;
  }
  if (!windows_process_running(process, result)) goto cleanup;
  if (!windows_creation_time(process, result->started_at, sizeof(result->started_at))) {
    set_windows_error(result, GetLastError(), "read process creation time", 0);
    goto cleanup;
  }
  if (!windows_executable(process, result->executable_path, sizeof(result->executable_path))) {
    set_windows_error(result, GetLastError(), "read executable path", 0);
    goto cleanup;
  }
  if (!windows_process_running(process, result)) goto cleanup;
  if (!copy_bounded(result->boot_id, sizeof(result->boot_id), "win32-filetime-1601-v1", strlen("win32-filetime-1601-v1"))) {
    set_native_error(result, OBSERVATION_NATIVE_ERROR, "Windows boot identity was malformed");
    goto cleanup;
  }
  result->ok = 1;
cleanup:
  (void)CloseHandle(process);
}
#endif

#if defined(_WIN32)
static int get_windows_path(const char *utf8_path, WCHAR *wide_path, size_t capacity) {
  int length;
  if (utf8_path == NULL || wide_path == NULL || capacity == 0) return 0;
  length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, utf8_path, -1, wide_path, (int)capacity);
  return length > 0 && (size_t)length < capacity;
}
static int normalize_windows_path(const WCHAR *source, WCHAR *destination, size_t capacity) {
  const WCHAR *cursor = source;
  size_t length = 0;
  if (source == NULL || destination == NULL || capacity < 2) return 0;
  if (_wcsnicmp(cursor, L"\\\\?\\UNC\\", 8) == 0) {
    if (capacity < 3) return 0;
    destination[length++] = L'\\';
    destination[length++] = L'\\';
    cursor += 8;
  } else if (_wcsnicmp(cursor, L"\\\\?\\", 4) == 0 || _wcsnicmp(cursor, L"\\\\.\\", 4) == 0) {
    cursor += 4;
  }
  while (*cursor != L'\0') {
    if (length + 1 >= capacity) return 0;
    destination[length++] = *cursor++;
  }
  while (length > 3 && destination[length - 1] == L'\\') length--;
  destination[length] = L'\0';
  return 1;
}

static int windows_directory_path_matches_handle(const WCHAR *requested, HANDLE handle) {
  WCHAR full_path[32768];
  WCHAR final_path[32768];
  WCHAR normalized_full[32768];
  WCHAR normalized_final[32768];
  DWORD full_length;
  DWORD final_length;
  full_length = GetFullPathNameW(requested, (DWORD)(sizeof(full_path) / sizeof(full_path[0])), full_path, NULL);
  final_length = GetFinalPathNameByHandleW(handle, final_path, (DWORD)(sizeof(final_path) / sizeof(final_path[0])), FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
  if (full_length == 0 || full_length >= sizeof(full_path) / sizeof(full_path[0]) || final_length == 0 || final_length >= sizeof(final_path) / sizeof(final_path[0])) return 0;
  if (!normalize_windows_path(full_path, normalized_full, sizeof(normalized_full) / sizeof(normalized_full[0])) ||
      !normalize_windows_path(final_path, normalized_final, sizeof(normalized_final) / sizeof(normalized_final[0]))) return 0;
  return _wcsicmp(normalized_full, normalized_final) == 0;
}

static int read_private_directory_windows(const char *path, private_file_observation *result) {
  WCHAR wide_path[32768];
  HANDLE handle = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION basic_information;
  FILE_STANDARD_INFO standard_information;
  FILE_ID_INFO id_information;
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory path was malformed");
    return 0;
  }
  handle = CreateFileW(wide_path, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error_number = GetLastError();
    set_private_error(result, error_number == ERROR_FILE_NOT_FOUND || error_number == ERROR_PATH_NOT_FOUND ? OBSERVATION_NOT_FOUND :
      error_number == ERROR_ACCESS_DENIED ? OBSERVATION_ACCESS_DENIED : OBSERVATION_NATIVE_ERROR, "open runtime directory");
    return 0;
  }
  if (!GetFileInformationByHandle(handle, &basic_information) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id_information, sizeof(id_information)) ||
      (basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !standard_information.Directory ||
      !windows_directory_path_matches_handle(wide_path, handle) || !windows_private_security(handle)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory security policy rejected directory");
    goto cleanup;
  }
  {
    int written = snprintf(result->volume_serial, sizeof(result->volume_serial), "%" PRIu64, (uint64_t)id_information.VolumeSerialNumber);
    if (written <= 0 || (size_t)written >= sizeof(result->volume_serial)) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory volume identity was malformed");
      goto cleanup;
    }
  }
  {
    DWORD index;
    for (index = 0; index < sizeof(id_information.FileId.Identifier); index++) {
      if (snprintf(result->file_id + index * 2, sizeof(result->file_id) - index * 2, "%02x", id_information.FileId.Identifier[index]) != 2) {
        set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory identity was malformed");
        goto cleanup;
      }
    }
  }
  result->ok = 1;
cleanup:
  if (handle != INVALID_HANDLE_VALUE) (void)CloseHandle(handle);
  return result->ok;
}


static int read_private_file_windows(const char *path, size_t maximum, int include_bytes, private_file_observation *result) {
  WCHAR wide_path[32768];
  HANDLE handle = INVALID_HANDLE_VALUE;
  BY_HANDLE_FILE_INFORMATION basic_information;
  FILE_STANDARD_INFO standard_information;
  FILE_ID_INFO id_information;
  LARGE_INTEGER remaining;
  DWORD bytes_read;
  size_t total = 0;
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file path was malformed");
    return 0;
  }
  handle = CreateFileW(wide_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error_number = GetLastError();
    set_private_error(result, error_number == ERROR_FILE_NOT_FOUND || error_number == ERROR_PATH_NOT_FOUND ? OBSERVATION_NOT_FOUND :
      error_number == ERROR_ACCESS_DENIED ? OBSERVATION_ACCESS_DENIED : OBSERVATION_NATIVE_ERROR, "open runtime file");
    return 0;
  }
  if (!GetFileInformationByHandle(handle, &basic_information) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id_information, sizeof(id_information))) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime file metadata");
    goto cleanup;
  }
  if ((basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standard_information.Directory || standard_information.EndOfFile.QuadPart < 0 ||
      (include_bytes && ((uint64_t)standard_information.EndOfFile.QuadPart > maximum || (uint64_t)standard_information.EndOfFile.QuadPart > MAX_PRIVATE_FILE_BYTES)) ||
      !windows_private_security(handle)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file security policy rejected file");
    goto cleanup;
  }
  result->byte_count = include_bytes ? (size_t)standard_information.EndOfFile.QuadPart : 0;
  result->bytes = result->byte_count == 0 ? NULL : (unsigned char *)malloc(result->byte_count);
  if (result->byte_count != 0 && result->bytes == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file allocation failed");
    goto cleanup;
  }
  remaining.QuadPart = (LONGLONG)result->byte_count;
  while (remaining.QuadPart > 0) {
    DWORD request = remaining.QuadPart > 1024u * 1024u ? 1024u * 1024u : (DWORD)remaining.QuadPart;
    if (!ReadFile(handle, result->bytes + total, request, &bytes_read, NULL) || bytes_read == 0) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime file");
      goto cleanup;
    }
    total += bytes_read;
    remaining.QuadPart -= bytes_read;
  }
  {
    int written = snprintf(result->volume_serial, sizeof(result->volume_serial), "%" PRIu64, (uint64_t)id_information.VolumeSerialNumber);
    if (written <= 0 || (size_t)written >= sizeof(result->volume_serial)) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file volume identity was malformed");
      goto cleanup;
    }
  }
  {
    DWORD index;
    for (index = 0; index < sizeof(id_information.FileId.Identifier); index++) {
      if (snprintf(result->file_id + index * 2, sizeof(result->file_id) - index * 2, "%02x", id_information.FileId.Identifier[index]) != 2) {
        set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file identity was malformed");
        goto cleanup;
      }
    }
  }
  result->ok = 1;
cleanup:
  if (!result->ok) {
    free(result->bytes);
    result->bytes = NULL;
    result->byte_count = 0;
  }
  if (handle != INVALID_HANDLE_VALUE) (void)CloseHandle(handle);
  return result->ok;
}
#else
static int read_private_file_posix(const char *path, size_t maximum, int include_bytes, private_file_observation *result) {
  int descriptor = -1;
  struct stat metadata;
  struct stat final_metadata;
  unsigned char *bytes = NULL;
  size_t total = 0;
  ssize_t count;
  if (path == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file path was malformed");
    return 0;
  }
#ifdef O_NOFOLLOW
  descriptor = open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW);
#else
  descriptor = open(path, O_RDONLY | O_CLOEXEC);
#endif
  if (descriptor < 0) {
    set_private_errno_error(result, errno, "open runtime file");
    return 0;
  }
  if (fstat(descriptor, &metadata) != 0) {
    set_private_errno_error(result, errno, "stat runtime file");
    goto cleanup;
  }
  if (!S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077) != 0 || metadata.st_size < 0 ||
      (include_bytes && ((uint64_t)metadata.st_size > maximum || (uint64_t)metadata.st_size > MAX_PRIVATE_FILE_BYTES))) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file security policy rejected file");
    goto cleanup;
  }
  result->byte_count = include_bytes ? (size_t)metadata.st_size : 0;
  bytes = result->byte_count == 0 ? NULL : (unsigned char *)malloc(result->byte_count);
  if (result->byte_count != 0 && bytes == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file allocation failed");
    goto cleanup;
  }
  while (total < result->byte_count) {
    count = read(descriptor, bytes + total, result->byte_count - total);
    if (count < 0) {
      set_private_errno_error(result, errno, "read runtime file");
      goto cleanup;
    }
    if (count == 0) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file was truncated");
      goto cleanup;
    }
    total += (size_t)count;
  }
  if (fstat(descriptor, &final_metadata) != 0) {
    set_private_errno_error(result, errno, "recheck runtime file");
    goto cleanup;
  }
  if (include_bytes && ((uint64_t)final_metadata.st_size != result->byte_count || final_metadata.st_dev != metadata.st_dev || final_metadata.st_ino != metadata.st_ino)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file changed while being read");
    goto cleanup;
  }
  if (snprintf(result->device, sizeof(result->device), "%llu", (unsigned long long)metadata.st_dev) <= 0 ||
      snprintf(result->inode, sizeof(result->inode), "%llu", (unsigned long long)metadata.st_ino) <= 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file identity was malformed");
    goto cleanup;
  }
  result->bytes = bytes;
  bytes = NULL;
  result->ok = 1;
cleanup:
  free(bytes);
  if (descriptor >= 0) (void)close(descriptor);
  return result->ok;
}
static int read_private_directory_posix(const char *path, private_file_observation *result) {
  int descriptor = -1;
  struct stat metadata;
  if (path == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory path was malformed");
    return 0;
  }
  {
    int flags = O_RDONLY | O_CLOEXEC;
#ifdef O_DIRECTORY
    flags |= O_DIRECTORY;
#endif
#ifdef O_NOFOLLOW
    flags |= O_NOFOLLOW;
#endif
    descriptor = open(path, flags);
  }
  if (descriptor < 0) {
    set_private_errno_error(result, errno, "open runtime directory");
    return 0;
  }
  if (fstat(descriptor, &metadata) != 0) {
    set_private_errno_error(result, errno, "stat runtime directory");
    goto cleanup;
  }
  if (!S_ISDIR(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077) != 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory security policy rejected directory");
    goto cleanup;
  }
  if (snprintf(result->device, sizeof(result->device), "%llu", (unsigned long long)metadata.st_dev) <= 0 ||
      snprintf(result->inode, sizeof(result->inode), "%llu", (unsigned long long)metadata.st_ino) <= 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime directory identity was malformed");
    goto cleanup;
  }
  result->ok = 1;
cleanup:
  (void)close(descriptor);
  return result->ok;
}
#endif
static int get_max_bytes_argument(napi_env env, napi_value value, size_t *maximum);
static int get_utf8_argument(napi_env env, napi_value value, char *destination, size_t capacity);

static napi_value throw_authority_error(napi_env env, const char *message) {
  (void)napi_throw_error(env, NULL, message);
  return NULL;
}
#if defined(_WIN32)
typedef struct {
  HANDLE lock;
  HANDLE directory;
} authority_lock_handle;
typedef HANDLE authority_file_handle;
#define INVALID_AUTHORITY_FILE INVALID_HANDLE_VALUE

static int authority_lock_is_invalid(authority_lock_handle handle) {
  return handle.lock == INVALID_HANDLE_VALUE || handle.directory == INVALID_HANDLE_VALUE;
}

static authority_lock_handle open_authority_lock(const char *path, int read_only) {
  authority_lock_handle result = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
  WCHAR wide_path[32768];
  WCHAR directory_path[32768];
  WCHAR lock_path[32768];
  WCHAR *separator;
  size_t length;
  HANDLE directory;
  HANDLE lock;
  BY_HANDLE_FILE_INFORMATION basic_information;
  FILE_STANDARD_INFO standard_information;
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) return result;
  length = wcslen(wide_path);
  if (length + 1 >= sizeof(directory_path) / sizeof(directory_path[0]) || length + 6 >= sizeof(lock_path) / sizeof(lock_path[0])) return result;
  memcpy(directory_path, wide_path, (length + 1) * sizeof(WCHAR));
  separator = wcsrchr(directory_path, L'\\');
  if (separator == NULL) separator = wcsrchr(directory_path, L'/');
  if (separator == NULL || separator == directory_path) return result;
  if (separator == directory_path + 2 && directory_path[1] == L':') {
    separator[1] = L'\\';
    separator[2] = L'\0';
  } else {
    *separator = L'\0';
  }
  directory = CreateFileW(directory_path, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (directory == INVALID_HANDLE_VALUE || !GetFileInformationByHandle(directory, &basic_information) ||
      !GetFileInformationByHandleEx(directory, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      (basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || !standard_information.Directory ||
      !windows_directory_path_matches_handle(directory_path, directory) || !windows_private_security(directory)) {
    if (directory != INVALID_HANDLE_VALUE) (void)CloseHandle(directory);
    return result;
  }
  memcpy(lock_path, wide_path, (length + 1) * sizeof(WCHAR));
  memcpy(lock_path + length, L".lock", 6 * sizeof(WCHAR));
  lock = CreateFileW(lock_path, read_only ? GENERIC_READ : GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
    read_only ? OPEN_EXISTING : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (lock == INVALID_HANDLE_VALUE) {
    (void)CloseHandle(directory);
    return result;
  }
  if (!GetFileInformationByHandle(lock, &basic_information) ||
      !GetFileInformationByHandleEx(lock, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      (basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standard_information.Directory ||
      !windows_private_security(lock)) {
    (void)CloseHandle(lock);
    (void)CloseHandle(directory);
    return result;
  }
  result.lock = lock;
  result.directory = directory;
  return result;
}

static authority_file_handle open_authority_file(const char *path, int read_only) {
  WCHAR wide_path[32768];
  HANDLE handle;
  BY_HANDLE_FILE_INFORMATION basic_information;
  FILE_STANDARD_INFO standard_information;
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) return INVALID_AUTHORITY_FILE;
  /* Denying delete sharing pins the canonical Windows name without a hard-link alias. */
  handle = CreateFileW(wide_path, read_only ? GENERIC_READ : GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | (read_only ? 0 : FILE_SHARE_DELETE), NULL,
    read_only ? OPEN_EXISTING : OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return INVALID_AUTHORITY_FILE;
  if (!GetFileInformationByHandle(handle, &basic_information) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      (basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standard_information.Directory ||
      !windows_private_security(handle)) {
    (void)CloseHandle(handle);
    return INVALID_AUTHORITY_FILE;
  }
  return handle;
}

static int read_only_authority_path(const char *path, authority_file_handle canonical, char *stable_path, size_t capacity, authority_file_handle *alias_handle) {
  int written;
  (void)alias_handle;
  (void)canonical;
  written = snprintf(stable_path, capacity, "%s", path);
  return written > 0 && (size_t)written < capacity;
}
static int same_authority_file(authority_file_handle first, authority_file_handle second) {
  BY_HANDLE_FILE_INFORMATION left;
  BY_HANDLE_FILE_INFORMATION right;
  if (!GetFileInformationByHandle(first, &left) || !GetFileInformationByHandle(second, &right)) return 0;
  return left.dwVolumeSerialNumber == right.dwVolumeSerialNumber &&
    left.nFileIndexHigh == right.nFileIndexHigh && left.nFileIndexLow == right.nFileIndexLow;
}

static int create_authority_alias(const char *path, authority_file_handle canonical, char *alias, size_t capacity, authority_file_handle *alias_handle) {
  WCHAR wide_path[32768];
  WCHAR wide_alias[32768];
  const char *separator;
  char directory[MAX_IDENTITY_STRING];
  char basename[MAX_IDENTITY_STRING];
  size_t directory_length;
  size_t basename_length;
  static unsigned int counter = 0;
  unsigned int index;
  uint32_t nonce = (uint32_t)GetTickCount() ^ (uint32_t)GetCurrentProcessId() ^ ++counter;
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) return 0;
  separator = strrchr(path, '\\');
  if (separator == NULL) separator = strrchr(path, '/');
  if (separator == NULL || separator == path || separator[1] == '\0') return 0;
  directory_length = (size_t)(separator - path);
  basename_length = strlen(separator + 1);
  if (directory_length >= sizeof(directory) || basename_length >= sizeof(basename)) return 0;
  memcpy(directory, path, directory_length);
  directory[directory_length] = '\0';
  memcpy(basename, separator + 1, basename_length + 1);
  for (index = 0; index < 128; index++) {
    int written = snprintf(alias, capacity, "%s\\.%s.donwells-alias-%08x-%u", directory, basename, nonce, index);
    if (written <= 0 || (size_t)written >= capacity || !get_windows_path(alias, wide_alias, sizeof(wide_alias) / sizeof(wide_alias[0]))) return 0;
    if (!CreateHardLinkW(wide_alias, wide_path, NULL)) {
      if (GetLastError() == ERROR_FILE_EXISTS || GetLastError() == ERROR_ALREADY_EXISTS) continue;
      return 0;
    }
    {
      HANDLE opened = CreateFileW(wide_alias, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
        OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
      if (opened != INVALID_HANDLE_VALUE && same_authority_file(canonical, opened) && windows_private_security(opened)) {
        *alias_handle = opened;
        return 1;
      }
      if (opened != INVALID_HANDLE_VALUE) (void)CloseHandle(opened);
    }
    (void)DeleteFileW(wide_alias);
  }
  return 0;
}

static void close_authority_file(authority_file_handle handle) {
  if (handle != INVALID_AUTHORITY_FILE) (void)CloseHandle(handle);
}

static void remove_authority_alias(const char *alias) {
  WCHAR wide_alias[32768];
  char sidecar[MAX_IDENTITY_STRING];
  if (!get_windows_path(alias, wide_alias, sizeof(wide_alias) / sizeof(wide_alias[0]))) return;
  (void)DeleteFileW(wide_alias);
  if (snprintf(sidecar, sizeof(sidecar), "%s-wal", alias) > 0 && get_windows_path(sidecar, wide_alias, sizeof(wide_alias) / sizeof(wide_alias[0]))) (void)DeleteFileW(wide_alias);
  if (snprintf(sidecar, sizeof(sidecar), "%s-shm", alias) > 0 && get_windows_path(sidecar, wide_alias, sizeof(wide_alias) / sizeof(wide_alias[0]))) (void)DeleteFileW(wide_alias);
}

static int lock_authority_name(authority_lock_handle handle) {
  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof(overlapped));
  return LockFileEx(handle.lock, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &overlapped) != 0;
}

static void close_authority_lock(authority_lock_handle handle) {
  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof(overlapped));
  if (handle.lock != INVALID_HANDLE_VALUE) {
    (void)UnlockFileEx(handle.lock, 0, MAXDWORD, MAXDWORD, &overlapped);
    (void)CloseHandle(handle.lock);
  }
  if (handle.directory != INVALID_HANDLE_VALUE) (void)CloseHandle(handle.directory);
}
#else
typedef int authority_lock_handle;
#define INVALID_AUTHORITY_LOCK (-1)
static int authority_lock_is_invalid(authority_lock_handle handle) {
  return handle < 0;
}
typedef int authority_file_handle;
#define INVALID_AUTHORITY_FILE (-1)

static authority_lock_handle open_authority_lock(const char *path, int read_only) {
  char directory[MAX_IDENTITY_STRING];
  const char *separator;
  size_t length;
  int flags = O_RDONLY | O_CLOEXEC;
  int descriptor;
  struct stat metadata;
  (void)read_only;
  if (path == NULL || path[0] != '/') return INVALID_AUTHORITY_LOCK;
  separator = strrchr(path, '/');
  if (separator == NULL || separator == path) return INVALID_AUTHORITY_LOCK;
  length = (size_t)(separator - path);
  if (length == 0 || length >= sizeof(directory)) return INVALID_AUTHORITY_LOCK;
  memcpy(directory, path, length);
  directory[length] = '\0';
#ifdef O_DIRECTORY
  flags |= O_DIRECTORY;
#endif
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif
  descriptor = open(directory, flags);
  if (descriptor < 0) return INVALID_AUTHORITY_LOCK;
  if (fstat(descriptor, &metadata) != 0 || !S_ISDIR(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077) != 0) {
    (void)close(descriptor);
    return INVALID_AUTHORITY_LOCK;
  }
  return descriptor;
}

static authority_file_handle open_authority_file(const char *path, int read_only) {
  int flags = (read_only ? O_RDONLY : O_RDWR) | O_CLOEXEC;
  int descriptor;
  struct stat metadata;
  if (!read_only) flags |= O_CREAT;
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif
  descriptor = open(path, flags, 0600);
  if (descriptor < 0) return INVALID_AUTHORITY_FILE;
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077) != 0) {
    (void)close(descriptor);
    return INVALID_AUTHORITY_FILE;
  }
  return descriptor;
}

static int authority_parts(const char *path, char *directory, size_t directory_capacity, char *basename, size_t basename_capacity);
static int find_existing_alias(const char *directory, const char *basename, authority_file_handle canonical, int read_only, char *alias, size_t capacity, authority_file_handle *alias_handle);
static int authority_has_recovery_sidecar(const char *path, const char *directory, const char *basename, authority_file_handle canonical);

static int read_only_authority_path(const char *path, authority_file_handle canonical, char *stable_path, size_t capacity, authority_file_handle *alias_handle) {
  char directory[MAX_IDENTITY_STRING];
  char basename[MAX_IDENTITY_STRING];
  int written;
  (void)alias_handle;
  if (!authority_parts(path, directory, sizeof(directory), basename, sizeof(basename)) ||
      authority_has_recovery_sidecar(path, directory, basename, canonical)) return 0;
  written = snprintf(stable_path, capacity, "file:/dev/fd/%d?immutable=1", canonical);
  return written > 0 && (size_t)written < capacity;
}
static int same_authority_file(authority_file_handle first, authority_file_handle second) {
  struct stat left;
  struct stat right;
  if (fstat(first, &left) != 0 || fstat(second, &right) != 0) return 0;
  return left.st_dev == right.st_dev && left.st_ino == right.st_ino;
}

static int authority_parts(const char *path, char *directory, size_t directory_capacity, char *basename, size_t basename_capacity) {
  const char *separator = strrchr(path, '/');
  size_t directory_length;
  size_t basename_length;
  if (path == NULL || separator == NULL || separator == path || separator[1] == '\0') return 0;
  directory_length = (size_t)(separator - path);
  basename_length = strlen(separator + 1);
  if (directory_length >= directory_capacity || basename_length >= basename_capacity) return 0;
  memcpy(directory, path, directory_length);
  directory[directory_length] = '\0';
  memcpy(basename, separator + 1, basename_length + 1);
  return 1;
}

static int authority_alias_path(const char *directory, const char *basename, uint32_t nonce, unsigned int index, char *alias, size_t capacity) {
  int written = snprintf(alias, capacity, "%s/.%s.donwells-alias-%08x-%u", directory, basename, nonce, index);
  return written > 0 && (size_t)written < capacity;
}

static int open_matching_alias(const char *directory, const char *basename, const char *name, authority_file_handle canonical, int read_only, char *alias, size_t capacity, authority_file_handle *alias_handle) {
  char candidate[MAX_IDENTITY_STRING];
  authority_file_handle opened;
  if (strncmp(name, ".", 1) != 0 || strncmp(name + 1, basename, strlen(basename)) != 0 || strstr(name, ".donwells-alias-") == NULL) return 0;
  if (snprintf(candidate, sizeof(candidate), "%s/%s", directory, name) <= 0 || strlen(candidate) >= capacity) return 0;
  opened = open(candidate, (read_only ? O_RDONLY : O_RDWR) | O_CLOEXEC
#ifdef O_NOFOLLOW
    | O_NOFOLLOW
#endif
    , 0);
  if (opened < 0 || !same_authority_file(canonical, opened)) {
    if (opened >= 0) (void)close(opened);
    return 0;
  }
  memcpy(alias, candidate, strlen(candidate) + 1);
  *alias_handle = opened;
  return 1;
}

static int find_existing_alias(const char *directory, const char *basename, authority_file_handle canonical, int read_only, char *alias, size_t capacity, authority_file_handle *alias_handle) {
  DIR *entries = opendir(directory);
  struct dirent *entry;
  if (entries == NULL) return 0;
  while ((entry = readdir(entries)) != NULL) {
    if (open_matching_alias(directory, basename, entry->d_name, canonical, read_only, alias, capacity, alias_handle)) {
      (void)closedir(entries);
      return 1;
    }
  }
  (void)closedir(entries);
  return 0;
}

static int path_has_recovery_sidecar(const char *path) {
  char sidecar[MAX_IDENTITY_STRING];
  struct stat metadata;
  static const char *suffixes[] = { "-wal", "-journal" };
  size_t index;
  for (index = 0; index < sizeof(suffixes) / sizeof(suffixes[0]); index++) {
    int written = snprintf(sidecar, sizeof(sidecar), "%s%s", path, suffixes[index]);
    if (written <= 0 || (size_t)written >= sizeof(sidecar)) return 1;
    if (lstat(sidecar, &metadata) == 0 || errno != ENOENT) return 1;
  }
  return 0;
}

static int authority_has_recovery_sidecar(const char *path, const char *directory, const char *basename, authority_file_handle canonical) {
  DIR *entries;
  struct dirent *entry;
  if (path_has_recovery_sidecar(path)) return 1;
  entries = opendir(directory);
  if (entries == NULL) return 1;
  while ((entry = readdir(entries)) != NULL) {
    char alias[MAX_IDENTITY_STRING];
    authority_file_handle alias_handle = INVALID_AUTHORITY_FILE;
    if (!open_matching_alias(directory, basename, entry->d_name, canonical, 1, alias, sizeof(alias), &alias_handle)) continue;
    (void)close(alias_handle);
    if (path_has_recovery_sidecar(alias)) {
      (void)closedir(entries);
      return 1;
    }
  }
  (void)closedir(entries);
  return 0;
}

static int fill_secure_random(void *buffer, size_t length) {
#if defined(__APPLE__)
  arc4random_buf(buffer, length);
  return 1;
#elif defined(__linux__)
  unsigned char *bytes = (unsigned char *)buffer;
  size_t total = 0;
#if defined(SYS_getrandom)
  while (total < length) {
    ssize_t count = syscall(SYS_getrandom, bytes + total, length - total, 0);
    if (count > 0) {
      total += (size_t)count;
      continue;
    }
    if (count < 0 && errno == EINTR) continue;
    break;
  }
  if (total == length) return 1;
#endif
  {
    int descriptor = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (descriptor < 0) return 0;
    while (total < length) {
      ssize_t count = read(descriptor, bytes + total, length - total);
      if (count > 0) {
        total += (size_t)count;
        continue;
      }
      if (count < 0 && errno == EINTR) continue;
      (void)close(descriptor);
      return 0;
    }
    if (close(descriptor) != 0) return 0;
  }
  return 1;
#else
  (void)buffer;
  (void)length;
  return 0;
#endif
}

static int create_authority_alias(const char *path, authority_file_handle canonical, char *alias, size_t capacity, authority_file_handle *alias_handle) {
  char directory[MAX_IDENTITY_STRING];
  char basename[MAX_IDENTITY_STRING];
  unsigned int index;
  uint32_t nonce;
  if (!fill_secure_random(&nonce, sizeof(nonce))) return 0;
  if (!authority_parts(path, directory, sizeof(directory), basename, sizeof(basename))) return 0;
  if (find_existing_alias(directory, basename, canonical, 0, alias, capacity, alias_handle)) return 1;
  for (index = 0; index < 128; index++) {
    authority_file_handle opened;
    if (!authority_alias_path(directory, basename, nonce, index, alias, capacity)) return 0;
    if (link(path, alias) != 0) {
      if (errno == EEXIST) continue;
      return 0;
    }
    opened = open(alias, O_RDWR | O_CLOEXEC
#ifdef O_NOFOLLOW
      | O_NOFOLLOW
#endif
      , 0);
    if (opened >= 0 && same_authority_file(canonical, opened)) {
      *alias_handle = opened;
      return 1;
    }
    if (opened >= 0) (void)close(opened);
    (void)unlink(alias);
  }
  return 0;
}

static void close_authority_file(authority_file_handle handle) {
  if (handle != INVALID_AUTHORITY_FILE) (void)close(handle);
}

static void remove_authority_alias(const char *alias) {
  char sidecar[MAX_IDENTITY_STRING];
  (void)unlink(alias);
  if (snprintf(sidecar, sizeof(sidecar), "%s-wal", alias) > 0) (void)unlink(sidecar);
  if (snprintf(sidecar, sizeof(sidecar), "%s-shm", alias) > 0) (void)unlink(sidecar);
}

static int lock_authority_name(authority_lock_handle handle) {
  return flock(handle, LOCK_EX) == 0;
}

static void close_authority_lock(authority_lock_handle handle) {
  (void)flock(handle, LOCK_UN);
  (void)close(handle);
}
#endif

static napi_value with_runtime_authority_lock(napi_env env, napi_callback_info info) {
  napi_value arguments[3];
  napi_value callback_argument;
  size_t argument_count = 3;
  char path[MAX_IDENTITY_STRING];
  char alias[MAX_IDENTITY_STRING];
  napi_valuetype callback_type;
#if defined(_WIN32)
  authority_lock_handle lock_handle = { INVALID_HANDLE_VALUE, INVALID_HANDLE_VALUE };
#else
  authority_lock_handle lock_handle = INVALID_AUTHORITY_LOCK;
#endif
  authority_file_handle canonical_handle = INVALID_AUTHORITY_FILE;
  authority_file_handle alias_handle = INVALID_AUTHORITY_FILE;
  napi_value callback_result = NULL;
  napi_value global = NULL;
  int callback_ok = 0;
  bool read_only = false;
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok || argument_count < 2 ||
      !get_utf8_argument(env, arguments[0], path, sizeof(path)) ||
      napi_typeof(env, arguments[1], &callback_type) != napi_ok || callback_type != napi_function ||
      (argument_count >= 3 && napi_get_value_bool(env, arguments[2], &read_only) != napi_ok) ||
      napi_get_global(env, &global) != napi_ok) {
    return throw_authority_error(env, "runtime authority lock arguments were malformed");
  }
  lock_handle = open_authority_lock(path, read_only ? 1 : 0);
  if (authority_lock_is_invalid(lock_handle)) return throw_authority_error(env, "open runtime authority name lock failed");
  if (!lock_authority_name(lock_handle)) {
    close_authority_lock(lock_handle);
    return throw_authority_error(env, "lock runtime authority name failed");
  }
  canonical_handle = open_authority_file(path, read_only ? 1 : 0);
  if (canonical_handle == INVALID_AUTHORITY_FILE) {
    close_authority_lock(lock_handle);
    return throw_authority_error(env, "open runtime authority file failed");
  }
  if (!(read_only ? read_only_authority_path(path, canonical_handle, alias, sizeof(alias), &alias_handle)
        : create_authority_alias(path, canonical_handle, alias, sizeof(alias), &alias_handle))) {
    close_authority_file(canonical_handle);
    close_authority_lock(lock_handle);
    return throw_authority_error(env, read_only ? "open runtime authority stable read path failed" : "create runtime authority stable alias failed");
  }
  if (napi_create_string_utf8(env, alias, NAPI_AUTO_LENGTH, &callback_argument) != napi_ok ||
      napi_call_function(env, global, arguments[1], 1, &callback_argument, &callback_result) != napi_ok) {
    close_authority_file(alias_handle);
    close_authority_file(canonical_handle);
    if (!read_only) remove_authority_alias(alias);
    close_authority_lock(lock_handle);
    return NULL;
  }
  callback_ok = 1;
  if (alias_handle != INVALID_AUTHORITY_FILE && !same_authority_file(canonical_handle, alias_handle)) {
    callback_ok = 0;
    (void)napi_throw_error(env, NULL, "runtime authority stable alias identity changed");
  }
#if defined(_WIN32)
  {
    WCHAR wide_path[32768];
    WCHAR wide_alias[32768];
    HANDLE final_handle;
    if (callback_ok && (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0])) ||
        !get_windows_path(alias, wide_alias, sizeof(wide_alias) / sizeof(wide_alias[0])))) callback_ok = 0;
    final_handle = callback_ok ? CreateFileW(wide_path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL,
      OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL) : INVALID_HANDLE_VALUE;
    if (callback_ok && (final_handle == INVALID_HANDLE_VALUE || !same_authority_file(canonical_handle, final_handle))) {
      callback_ok = 0;
      (void)napi_throw_error(env, NULL, "runtime authority canonical identity changed during operation");
    }
    if (final_handle != INVALID_HANDLE_VALUE) (void)CloseHandle(final_handle);
  }
#else
  {
    authority_file_handle final_handle = callback_ok ? open(path, O_RDONLY | O_CLOEXEC
#ifdef O_NOFOLLOW
      | O_NOFOLLOW
#endif
      , 0) : INVALID_AUTHORITY_FILE;
    if (callback_ok && (final_handle == INVALID_AUTHORITY_FILE || !same_authority_file(canonical_handle, final_handle))) {
      callback_ok = 0;
      (void)napi_throw_error(env, NULL, "runtime authority canonical identity changed during operation");
    }
    close_authority_file(final_handle);
  }
#endif
  close_authority_file(alias_handle);
  close_authority_file(canonical_handle);
  if (!read_only) remove_authority_alias(alias);
  close_authority_lock(lock_handle);
  return callback_ok ? callback_result : NULL;
}

static int get_pid_argument(napi_env env, napi_value value, uint64_t *pid) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    (void)napi_throw_type_error(env, NULL, "pid must be a number");
    return 0;
  }
  if (napi_get_value_double(env, value, &number) != napi_ok || number <= 0 || number != number || number > 9007199254740991.0 || number != (double)(uint64_t)number) {
    return 0;
  }
  *pid = (uint64_t)number;
  return 1;
}

static int get_max_bytes_argument(napi_env env, napi_value value, size_t *maximum) {
  napi_valuetype type;
  double number;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_number) {
    (void)napi_throw_type_error(env, NULL, "maxBytes must be a number");
    return 0;
  }
  if (napi_get_value_double(env, value, &number) != napi_ok || number <= 0 || number != number || number > (double)MAX_PRIVATE_FILE_BYTES || number != (double)(size_t)number) return 0;
  *maximum = (size_t)number;
  return 1;
}

static int get_utf8_argument(napi_env env, napi_value value, char *destination, size_t capacity) {
  napi_valuetype type;
  size_t length = 0;
  if (napi_typeof(env, value, &type) != napi_ok || type != napi_string) {
    (void)napi_throw_type_error(env, NULL, "path must be a string");
    return 0;
  }
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length >= capacity ||
      napi_get_value_string_utf8(env, value, destination, capacity, &length) != napi_ok || destination[length] != '\0') return 0;
  return 1;
}

static napi_value read_process_identity(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argument_count = 1;
  uint64_t pid = 0;
  native_observation result;
  memset(&result, 0, sizeof(result));
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok || argument_count < 1 || !get_pid_argument(env, argument, &pid)) {
    if (argument_count < 1) (void)napi_throw_type_error(env, NULL, "readProcessIdentity requires a pid");
    set_native_error(&result, OBSERVATION_NATIVE_ERROR, "PID must be a positive safe integer");
    return make_observation_result(env, &result);
  }
#if defined(__linux__)
  read_process_identity_posix_linux(pid, &result);
#elif defined(__APPLE__)
  read_process_identity_posix_macos(pid, &result);
#elif defined(_WIN32)
  read_process_identity_windows(pid, &result);
#else
  set_native_error(&result, OBSERVATION_NATIVE_ERROR, "unsupported operating system");
#endif
  if (result.ok) result.pid = (uint32_t)pid;
  if (result.ok) {
    char pid_string[32];
    int written = snprintf(pid_string, sizeof(pid_string), "%" PRIu64, pid);
    if (written <= 0 || (size_t)written >= sizeof(pid_string)) {
      set_native_error(&result, OBSERVATION_NATIVE_ERROR, "PID was malformed");
    }
  }
  if (result.ok) {
    napi_value output;
    if (napi_create_object(env, &output) != napi_ok ||
        !set_boolean_property(env, output, "ok", 1) ||
        !set_uint32_property(env, output, "pid", (uint32_t)pid) ||
        !set_string_property(env, output, "bootId", result.boot_id) ||
        !set_string_property(env, output, "startedAt", result.started_at) ||
        !set_string_property(env, output, "executablePath", result.executable_path)) return NULL;
    return output;
  }
  return make_observation_result(env, &result);
}

static napi_value read_private_runtime_file(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  size_t argument_count = 2;
  char path[MAX_IDENTITY_STRING];
  size_t maximum = 0;
  private_file_observation result;
  memset(&result, 0, sizeof(result));
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok || argument_count < 2 ||
      !get_utf8_argument(env, arguments[0], path, sizeof(path)) || !get_max_bytes_argument(env, arguments[1], &maximum)) {
    set_private_error(&result, OBSERVATION_NATIVE_ERROR, "runtime file arguments were malformed");
    return make_private_result(env, &result);
  }
#if defined(_WIN32)
  (void)read_private_file_windows(path, maximum, 1, &result);
#elif defined(__linux__) || defined(__APPLE__)
  (void)read_private_file_posix(path, maximum, 1, &result);
#else
  set_private_error(&result, OBSERVATION_NATIVE_ERROR, "unsupported operating system");
#endif
  {
    napi_value output = make_private_result(env, &result);
    free(result.bytes);
    return output;
  }
}
static napi_value read_private_runtime_file_identity(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argument_count = 1;
  char path[MAX_IDENTITY_STRING];
  private_file_observation result;
  memset(&result, 0, sizeof(result));
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok || argument_count < 1 ||
      !get_utf8_argument(env, argument, path, sizeof(path))) {
    set_private_error(&result, OBSERVATION_NATIVE_ERROR, "runtime file identity argument was malformed");
    return make_private_result(env, &result);
  }
#if defined(_WIN32)
  (void)read_private_file_windows(path, 0, 0, &result);
#elif defined(__linux__) || defined(__APPLE__)
  (void)read_private_file_posix(path, 0, 0, &result);
#else
  set_private_error(&result, OBSERVATION_NATIVE_ERROR, "unsupported operating system");
#endif
  return make_private_result(env, &result);
}
static napi_value validate_private_runtime_directory(napi_env env, napi_callback_info info) {
  napi_value argument;
  size_t argument_count = 1;
  char path[MAX_IDENTITY_STRING];
  private_file_observation result;
  memset(&result, 0, sizeof(result));
  if (napi_get_cb_info(env, info, &argument_count, &argument, NULL, NULL) != napi_ok || argument_count < 1 ||
      !get_utf8_argument(env, argument, path, sizeof(path))) {
    set_private_error(&result, OBSERVATION_NATIVE_ERROR, "runtime directory argument was malformed");
    return make_private_result(env, &result);
  }
#if defined(_WIN32)
  (void)read_private_directory_windows(path, &result);
#elif defined(__linux__) || defined(__APPLE__)
  (void)read_private_directory_posix(path, &result);
#else
  set_private_error(&result, OBSERVATION_NATIVE_ERROR, "unsupported operating system");
#endif
  return make_private_result(env, &result);
}

static napi_value rename_runtime_path_no_replace(napi_env env, napi_callback_info info) {
  napi_value arguments[2];
  size_t argument_count = 2;
  char source_path[MAX_IDENTITY_STRING];
  char destination_path[MAX_IDENTITY_STRING];
  int renamed = 0;
  int error_number = 0;
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok || argument_count < 2 ||
      !get_utf8_argument(env, arguments[0], source_path, sizeof(source_path)) ||
      !get_utf8_argument(env, arguments[1], destination_path, sizeof(destination_path))) {
    return make_rename_result(env, 0, "native-error", "runtime rename arguments were malformed");
  }
#if defined(_WIN32)
  {
    WCHAR wide_source[32768];
    WCHAR wide_destination[32768];
    if (!get_windows_path(source_path, wide_source, sizeof(wide_source) / sizeof(wide_source[0])) ||
        !get_windows_path(destination_path, wide_destination, sizeof(wide_destination) / sizeof(wide_destination[0]))) {
      return make_rename_result(env, 0, "native-error", "runtime rename paths were malformed");
    }
    renamed = MoveFileW(wide_source, wide_destination) != 0;
    if (!renamed) {
      DWORD windows_error = GetLastError();
      if (windows_error == ERROR_ALREADY_EXISTS || windows_error == ERROR_FILE_EXISTS) return make_rename_result(env, 0, "destination-exists", "runtime rename destination exists");
      if (windows_error == ERROR_FILE_NOT_FOUND || windows_error == ERROR_PATH_NOT_FOUND) return make_rename_result(env, 0, "not-found", "runtime rename source was not found");
      if (windows_error == ERROR_ACCESS_DENIED || windows_error == ERROR_SHARING_VIOLATION) return make_rename_result(env, 0, "access-denied", "runtime rename access was denied");
      return make_rename_result(env, 0, "native-error", "runtime rename failed");
    }
  }
#elif defined(__APPLE__)
  renamed = renamex_np(source_path, destination_path, RENAME_EXCL) == 0;
  if (!renamed) error_number = errno;
#elif defined(__linux__) && defined(SYS_renameat2)
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE (1 << 0)
#endif
  renamed = syscall(SYS_renameat2, AT_FDCWD, source_path, AT_FDCWD, destination_path, RENAME_NOREPLACE) == 0;
  if (!renamed) error_number = errno;
#else
  return make_rename_result(env, 0, "native-error", "atomic no-replace rename is unsupported");
#endif
#if !defined(_WIN32)
  if (!renamed) {
    char message[MAX_NATIVE_MESSAGE];
    int written = snprintf(message, sizeof(message), "runtime rename failed: %s", strerror(error_number));
    if (written < 0 || (size_t)written >= sizeof(message)) set_message(message, sizeof(message), "runtime rename failed");
    return make_rename_result(env, 0, rename_error_code(error_number), message);
  }
#endif
  return make_rename_result(env, 1, NULL, NULL);
}

NAPI_MODULE_INIT() {
  napi_value platform;
  napi_value validate_directory;
  napi_value identity_contract;
  napi_value file_security_contract;
  napi_value read_identity;
  napi_value read_file;
  napi_value read_file_identity;
  napi_value with_authority_lock;
  napi_value rename_no_replace;
#if defined(_WIN32)
  const char *platform_name = "win32";
#elif defined(__APPLE__)
  const char *platform_name = "darwin";
#elif defined(__linux__)
  const char *platform_name = "linux";
#else
  const char *platform_name = "unsupported";
#endif
  if (napi_create_string_utf8(env, platform_name, NAPI_AUTO_LENGTH, &platform) != napi_ok ||
      napi_create_int32(env, IDENTITY_CONTRACT_VERSION, &identity_contract) != napi_ok ||
      napi_create_function(env, "validatePrivateRuntimeDirectory", NAPI_AUTO_LENGTH, validate_private_runtime_directory, NULL, &validate_directory) != napi_ok ||
      napi_create_int32(env, RUNTIME_FILE_SECURITY_CONTRACT_VERSION, &file_security_contract) != napi_ok ||
      napi_create_function(env, "readProcessIdentity", NAPI_AUTO_LENGTH, read_process_identity, NULL, &read_identity) != napi_ok ||
      napi_create_function(env, "readPrivateRuntimeFile", NAPI_AUTO_LENGTH, read_private_runtime_file, NULL, &read_file) != napi_ok ||
      napi_create_function(env, "readPrivateRuntimeFileIdentity", NAPI_AUTO_LENGTH, read_private_runtime_file_identity, NULL, &read_file_identity) != napi_ok ||
      napi_create_function(env, "withRuntimeAuthorityLock", NAPI_AUTO_LENGTH, with_runtime_authority_lock, NULL, &with_authority_lock) != napi_ok ||
      napi_create_function(env, "renameRuntimePathNoReplace", NAPI_AUTO_LENGTH, rename_runtime_path_no_replace, NULL, &rename_no_replace) != napi_ok ||
      napi_set_named_property(env, exports, "platform", platform) != napi_ok ||
      napi_set_named_property(env, exports, "identityContractVersion", identity_contract) != napi_ok ||
      napi_set_named_property(env, exports, "validatePrivateRuntimeDirectory", validate_directory) != napi_ok ||
      napi_set_named_property(env, exports, "runtimeFileSecurityContractVersion", file_security_contract) != napi_ok ||
      napi_set_named_property(env, exports, "readProcessIdentity", read_identity) != napi_ok ||
      napi_set_named_property(env, exports, "readPrivateRuntimeFile", read_file) != napi_ok ||
      napi_set_named_property(env, exports, "readPrivateRuntimeFileIdentity", read_file_identity) != napi_ok ||
      napi_set_named_property(env, exports, "withRuntimeAuthorityLock", with_authority_lock) != napi_ok ||
      napi_set_named_property(env, exports, "renameRuntimePathNoReplace", rename_no_replace) != napi_ok) return NULL;
  return exports;
}
