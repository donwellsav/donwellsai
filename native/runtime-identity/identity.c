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
#include <aclapi.h>
#include <sddl.h>
#else
#include <fcntl.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <libproc.h>
#include <limits.h>
#include <sys/sysctl.h>
#else
#include <limits.h>
#endif
#endif

#define IDENTITY_CONTRACT_VERSION 1
#define RUNTIME_FILE_SECURITY_CONTRACT_VERSION 1
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

static int windows_sid_allowed(PSID sid, PSID current_user, PSID local_system, PSID administrators) {
  if (sid == NULL || current_user == NULL || local_system == NULL || administrators == NULL || !IsValidSid(sid)) return 0;
  return EqualSid(sid, current_user) || EqualSid(sid, local_system) || EqualSid(sid, administrators);
}

static int windows_private_security(HANDLE handle) {
  PSECURITY_DESCRIPTOR security_descriptor = NULL;
  PSID owner = NULL;
  PACL dacl = NULL;
  BOOL dacl_present = FALSE;
  PSID current_user = NULL;
  PSID local_system = NULL;
  PSID administrators = NULL;
  DWORD token_length = 0;
  HANDLE token = NULL;
  TOKEN_USER *token_user = NULL;
  BYTE local_system_buffer[SECURITY_MAX_SID_SIZE];
  BYTE administrators_buffer[SECURITY_MAX_SID_SIZE];
  DWORD sid_length = sizeof(local_system_buffer);
  DWORD administrators_length = sizeof(administrators_buffer);
  ACL_SIZE_INFORMATION acl_size;
  BOOL valid = FALSE;
  if (GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      &owner, NULL, &dacl, NULL, &security_descriptor) != ERROR_SUCCESS) goto cleanup;
  if (owner == NULL || !IsValidSid(owner) || !OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) goto cleanup;
  (void)GetTokenInformation(token, TokenUser, NULL, 0, &token_length);
  if (token_length == 0) goto cleanup;
  token_user = (TOKEN_USER *)malloc(token_length);
  if (token_user == NULL || !GetTokenInformation(token, TokenUser, token_user, token_length, &token_length)) goto cleanup;
  current_user = token_user->User.Sid;
  if (!EqualSid(owner, current_user)) goto cleanup;
  if (!CreateWellKnownSid(WinLocalSystemSid, NULL, local_system_buffer, &sid_length) ||
      !CreateWellKnownSid(WinBuiltinAdministratorsSid, NULL, administrators_buffer, &administrators_length)) goto cleanup;
  local_system = local_system_buffer;
  administrators = administrators_buffer;
  if (!GetSecurityDescriptorDacl(security_descriptor, &dacl_present, &dacl, NULL) || !dacl_present || dacl == NULL) goto cleanup;
  memset(&acl_size, 0, sizeof(acl_size));
  if (!GetAclInformation(dacl, &acl_size, sizeof(acl_size), AclSizeInformation)) goto cleanup;
  {
    DWORD index;
    for (index = 0; index < acl_size.AceCount; index++) {
      ACE_HEADER *header = NULL;
      if (!GetAce(dacl, index, (LPVOID *)&header) || header == NULL) goto cleanup;
      if (header->AceType == ACCESS_ALLOWED_ACE_TYPE) {
        ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)header;
        if (!IsValidSid((PSID)&ace->SidStart) ||
            ((ace->Mask & (FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE | DELETE | READ_CONTROL | WRITE_DAC | WRITE_OWNER)) != 0 &&
             !windows_sid_allowed(&ace->SidStart, current_user, local_system, administrators))) goto cleanup;
      } else if (header->AceType != ACCESS_DENIED_ACE_TYPE) {
        goto cleanup;
      }
    }
  }
  valid = TRUE;
cleanup:
  if (token != NULL) (void)CloseHandle(token);
  if (security_descriptor != NULL) (void)LocalFree(security_descriptor);
  free(token_user);
  return valid ? 1 : 0;
}

static int read_private_file_windows(const char *path, size_t maximum, private_file_observation *result) {
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
      (uint64_t)standard_information.EndOfFile.QuadPart > maximum || (uint64_t)standard_information.EndOfFile.QuadPart > MAX_PRIVATE_FILE_BYTES || !windows_private_security(handle)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file security policy rejected file");
    goto cleanup;
  }
  result->byte_count = (size_t)standard_information.EndOfFile.QuadPart;
  result->bytes = result->byte_count == 0 ? NULL : (unsigned char *)malloc(result->byte_count);
  if (result->byte_count != 0 && result->bytes == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file allocation failed");
    goto cleanup;
  }
  remaining.QuadPart = standard_information.EndOfFile.QuadPart;
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
static int read_private_file_posix(const char *path, size_t maximum, private_file_observation *result) {
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
      (uint64_t)metadata.st_size > maximum || (uint64_t)metadata.st_size > MAX_PRIVATE_FILE_BYTES) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime file security policy rejected file");
    goto cleanup;
  }
  result->byte_count = (size_t)metadata.st_size;
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
  if ((uint64_t)final_metadata.st_size != result->byte_count || final_metadata.st_dev != metadata.st_dev || final_metadata.st_ino != metadata.st_ino) {
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
#endif
static int get_max_bytes_argument(napi_env env, napi_value value, size_t *maximum);
static int get_utf8_argument(napi_env env, napi_value value, char *destination, size_t capacity);

static napi_value throw_authority_error(napi_env env, const char *message) {
  (void)napi_throw_error(env, NULL, message);
  return NULL;
}

#if defined(_WIN32)
typedef HANDLE authority_handle;
#define INVALID_AUTHORITY_HANDLE INVALID_HANDLE_VALUE

static authority_handle open_authority(const char *path, int read_only, private_file_observation *result) {
  WCHAR wide_path[32768];
  HANDLE handle;
  BY_HANDLE_FILE_INFORMATION basic_information;
  FILE_STANDARD_INFO standard_information;
  FILE_ID_INFO id_information;
  DWORD disposition = read_only ? OPEN_EXISTING : OPEN_ALWAYS;
  DWORD access = GENERIC_READ | (read_only ? 0 : GENERIC_WRITE);
  if (!get_windows_path(path, wide_path, sizeof(wide_path) / sizeof(wide_path[0]))) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority path was malformed");
    return INVALID_AUTHORITY_HANDLE;
  }
  handle = CreateFileW(wide_path, access, FILE_SHARE_READ | FILE_SHARE_WRITE, NULL,
    disposition, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    DWORD error_number = GetLastError();
    set_private_error(result, error_number == ERROR_FILE_NOT_FOUND || error_number == ERROR_PATH_NOT_FOUND ? OBSERVATION_NOT_FOUND :
      error_number == ERROR_ACCESS_DENIED ? OBSERVATION_ACCESS_DENIED : OBSERVATION_NATIVE_ERROR, "open runtime authority");
    return INVALID_AUTHORITY_HANDLE;
  }
  if (!GetFileInformationByHandle(handle, &basic_information) ||
      !GetFileInformationByHandleEx(handle, FileStandardInfo, &standard_information, sizeof(standard_information)) ||
      !GetFileInformationByHandleEx(handle, FileIdInfo, &id_information, sizeof(id_information)) ||
      (basic_information.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0 || standard_information.Directory ||
      standard_information.EndOfFile.QuadPart < 0 || !windows_private_security(handle)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority security policy rejected file");
    (void)CloseHandle(handle);
    return INVALID_AUTHORITY_HANDLE;
  }
  if (snprintf(result->volume_serial, sizeof(result->volume_serial), "%" PRIu64, (uint64_t)id_information.VolumeSerialNumber) <= 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority volume identity was malformed");
    (void)CloseHandle(handle);
    return INVALID_AUTHORITY_HANDLE;
  }
  {
    DWORD index;
    for (index = 0; index < sizeof(id_information.FileId.Identifier); index++) {
      if (snprintf(result->file_id + index * 2, sizeof(result->file_id) - index * 2, "%02x", id_information.FileId.Identifier[index]) != 2) {
        set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority file identity was malformed");
        (void)CloseHandle(handle);
        return INVALID_AUTHORITY_HANDLE;
      }
    }
  }
  return handle;
}

static int lock_authority(authority_handle handle) {
  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof(overlapped));
  return LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, MAXDWORD, MAXDWORD, &overlapped) != 0;
}

static void unlock_authority(authority_handle handle) {
  OVERLAPPED overlapped;
  memset(&overlapped, 0, sizeof(overlapped));
  (void)UnlockFileEx(handle, 0, MAXDWORD, MAXDWORD, &overlapped);
}

static int read_authority(authority_handle handle, size_t maximum, private_file_observation *result) {
  LARGE_INTEGER size;
  LARGE_INTEGER zero;
  DWORD count;
  size_t total = 0;
  zero.QuadPart = 0;
  if (!GetFileSizeEx(handle, &size) || size.QuadPart < 0 || (uint64_t)size.QuadPart > maximum ||
      (uint64_t)size.QuadPart > MAX_PRIVATE_FILE_BYTES || !SetFilePointerEx(handle, zero, NULL, FILE_BEGIN)) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime authority metadata");
    return 0;
  }
  result->byte_count = (size_t)size.QuadPart;
  result->bytes = result->byte_count == 0 ? NULL : (unsigned char *)malloc(result->byte_count);
  if (result->byte_count != 0 && result->bytes == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority allocation failed");
    return 0;
  }
  while (total < result->byte_count) {
    DWORD request = result->byte_count - total > 1024u * 1024u ? 1024u * 1024u : (DWORD)(result->byte_count - total);
    if (!ReadFile(handle, result->bytes + total, request, &count, NULL) || count == 0) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime authority");
      return 0;
    }
    total += count;
  }
  result->ok = 1;
  return 1;
}

static int append_authority(authority_handle handle, const unsigned char *bytes, size_t length) {
  LARGE_INTEGER end;
  size_t total = 0;
  DWORD written;
  end.QuadPart = 0;
  if (!SetFilePointerEx(handle, end, NULL, FILE_END)) return 0;
  while (total < length) {
    DWORD request = length - total > 1024u * 1024u ? 1024u * 1024u : (DWORD)(length - total);
    if (!WriteFile(handle, bytes + total, request, &written, NULL) || written == 0) return 0;
    total += written;
  }
  return FlushFileBuffers(handle) != 0;
}
#else
typedef int authority_handle;
#define INVALID_AUTHORITY_HANDLE (-1)

static authority_handle open_authority(const char *path, int read_only, private_file_observation *result) {
  int flags = (read_only ? O_RDONLY : O_RDWR | O_CREAT) | O_CLOEXEC;
  int descriptor;
  struct stat metadata;
#ifdef O_NOFOLLOW
  flags |= O_NOFOLLOW;
#endif
  descriptor = open(path, flags, 0600);
  if (descriptor < 0) {
    set_private_errno_error(result, errno, "open runtime authority");
    return INVALID_AUTHORITY_HANDLE;
  }
  if (fstat(descriptor, &metadata) != 0 || !S_ISREG(metadata.st_mode) || metadata.st_uid != geteuid() || (metadata.st_mode & 0077) != 0 || metadata.st_size < 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority security policy rejected file");
    (void)close(descriptor);
    return INVALID_AUTHORITY_HANDLE;
  }
  if (snprintf(result->device, sizeof(result->device), "%llu", (unsigned long long)metadata.st_dev) <= 0 ||
      snprintf(result->inode, sizeof(result->inode), "%llu", (unsigned long long)metadata.st_ino) <= 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority identity was malformed");
    (void)close(descriptor);
    return INVALID_AUTHORITY_HANDLE;
  }
  return descriptor;
}

static int lock_authority(authority_handle handle) {
  return flock(handle, LOCK_EX) == 0;
}

static void unlock_authority(authority_handle handle) {
  (void)flock(handle, LOCK_UN);
}

static int read_authority(authority_handle handle, size_t maximum, private_file_observation *result) {
  struct stat metadata;
  size_t total = 0;
  ssize_t count;
  if (fstat(handle, &metadata) != 0 || metadata.st_size < 0 || (uint64_t)metadata.st_size > maximum ||
      (uint64_t)metadata.st_size > MAX_PRIVATE_FILE_BYTES || lseek(handle, 0, SEEK_SET) < 0) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime authority metadata");
    return 0;
  }
  result->byte_count = (size_t)metadata.st_size;
  result->bytes = result->byte_count == 0 ? NULL : (unsigned char *)malloc(result->byte_count);
  if (result->byte_count != 0 && result->bytes == NULL) {
    set_private_error(result, OBSERVATION_NATIVE_ERROR, "runtime authority allocation failed");
    return 0;
  }
  while (total < result->byte_count) {
    count = read(handle, result->bytes + total, result->byte_count - total);
    if (count <= 0) {
      set_private_error(result, OBSERVATION_NATIVE_ERROR, "read runtime authority");
      return 0;
    }
    total += (size_t)count;
  }
  result->ok = 1;
  return 1;
}

static int append_authority(authority_handle handle, const unsigned char *bytes, size_t length) {
  size_t total = 0;
  ssize_t count;
  if (lseek(handle, 0, SEEK_END) < 0) return 0;
  while (total < length) {
    count = write(handle, bytes + total, length - total);
    if (count <= 0) return 0;
    total += (size_t)count;
  }
  return fsync(handle) == 0;
}
#endif

static napi_value with_runtime_authority(napi_env env, napi_callback_info info) {
  napi_value arguments[4];
  size_t argument_count = 4;
  char path[MAX_IDENTITY_STRING];
  bool read_only = false;
  size_t maximum = 0;
  napi_valuetype callback_type;
  authority_handle handle = INVALID_AUTHORITY_HANDLE;
  private_file_observation observation;
  napi_value callback_observation = NULL;
  napi_value callback_result = NULL;
  napi_value global = NULL;
  napi_value result_value = NULL;
  napi_value append_value = NULL;
  bool has_append = false;
  void *append_bytes = NULL;
  size_t append_length = 0;
  memset(&observation, 0, sizeof(observation));
  if (napi_get_cb_info(env, info, &argument_count, arguments, NULL, NULL) != napi_ok || argument_count < 4 ||
      !get_utf8_argument(env, arguments[0], path, sizeof(path)) || napi_get_value_bool(env, arguments[1], &read_only) != napi_ok ||
      !get_max_bytes_argument(env, arguments[2], &maximum) || napi_typeof(env, arguments[3], &callback_type) != napi_ok || callback_type != napi_function ||
      napi_get_global(env, &global) != napi_ok) {
    return throw_authority_error(env, "runtime authority arguments were malformed");
  }
  handle = open_authority(path, read_only ? 1 : 0, &observation);
  if (handle == INVALID_AUTHORITY_HANDLE) return throw_authority_error(env, observation.message);
  if (!lock_authority(handle)) {
#if defined(_WIN32)
    (void)CloseHandle(handle);
#else
    (void)close(handle);
#endif
    return throw_authority_error(env, "lock runtime authority failed");
  }
  if (!read_authority(handle, maximum, &observation)) goto authority_error;
  callback_observation = make_private_result(env, &observation);
  if (callback_observation == NULL || napi_call_function(env, global, arguments[3], 1, &callback_observation, &callback_result) != napi_ok) goto authority_exception;
  if (callback_result == NULL || napi_get_named_property(env, callback_result, "result", &result_value) != napi_ok ||
      napi_has_named_property(env, callback_result, "append", &has_append) != napi_ok) {
    set_private_error(&observation, OBSERVATION_NATIVE_ERROR, "runtime authority callback result was malformed");
    goto authority_error;
  }
  if (has_append) {
    if (read_only || napi_get_named_property(env, callback_result, "append", &append_value) != napi_ok ||
        napi_is_buffer(env, append_value, &has_append) != napi_ok || !has_append ||
        napi_get_buffer_info(env, append_value, &append_bytes, &append_length) != napi_ok ||
        append_length > maximum - observation.byte_count || !append_authority(handle, (const unsigned char *)append_bytes, append_length)) {
      set_private_error(&observation, OBSERVATION_NATIVE_ERROR, "append runtime authority failed");
      goto authority_error;
    }
  }
  free(observation.bytes);
  unlock_authority(handle);
#if defined(_WIN32)
  (void)CloseHandle(handle);
#else
  (void)close(handle);
#endif
  return result_value;
authority_error:
  free(observation.bytes);
  unlock_authority(handle);
#if defined(_WIN32)
  (void)CloseHandle(handle);
#else
  (void)close(handle);
#endif
  return throw_authority_error(env, observation.message);
authority_exception:
  free(observation.bytes);
  unlock_authority(handle);
#if defined(_WIN32)
  (void)CloseHandle(handle);
#else
  (void)close(handle);
#endif
  return NULL;
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
  (void)read_private_file_windows(path, maximum, &result);
#elif defined(__linux__) || defined(__APPLE__)
  (void)read_private_file_posix(path, maximum, &result);
#else
  set_private_error(&result, OBSERVATION_NATIVE_ERROR, "unsupported operating system");
#endif
  {
    napi_value output = make_private_result(env, &result);
    free(result.bytes);
    return output;
  }
}

NAPI_MODULE_INIT() {
  napi_value platform;
  napi_value identity_contract;
  napi_value file_security_contract;
  napi_value read_identity;
  napi_value read_file;
  napi_value with_authority;
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
      napi_create_int32(env, RUNTIME_FILE_SECURITY_CONTRACT_VERSION, &file_security_contract) != napi_ok ||
      napi_create_function(env, "readProcessIdentity", NAPI_AUTO_LENGTH, read_process_identity, NULL, &read_identity) != napi_ok ||
      napi_create_function(env, "readPrivateRuntimeFile", NAPI_AUTO_LENGTH, read_private_runtime_file, NULL, &read_file) != napi_ok ||
      napi_create_function(env, "withRuntimeAuthority", NAPI_AUTO_LENGTH, with_runtime_authority, NULL, &with_authority) != napi_ok ||
      napi_set_named_property(env, exports, "platform", platform) != napi_ok ||
      napi_set_named_property(env, exports, "identityContractVersion", identity_contract) != napi_ok ||
      napi_set_named_property(env, exports, "runtimeFileSecurityContractVersion", file_security_contract) != napi_ok ||
      napi_set_named_property(env, exports, "readProcessIdentity", read_identity) != napi_ok ||
      napi_set_named_property(env, exports, "readPrivateRuntimeFile", read_file) != napi_ok ||
      napi_set_named_property(env, exports, "withRuntimeAuthority", with_authority) != napi_ok) return NULL;
  return exports;
}
