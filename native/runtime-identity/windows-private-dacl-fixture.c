#define UNICODE
#define _UNICODE

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>

#include <stdio.h>

#include "windows-file-security.h"

static int configure_allow_ace(const WCHAR *path, PSID sid, ACCESS_MASK permissions) {
  EXPLICIT_ACCESS_W entry;
  PACL acl = NULL;
  DWORD error_number;
  memset(&entry, 0, sizeof(entry));
  entry.grfAccessPermissions = permissions;
  entry.grfAccessMode = GRANT_ACCESS;
  entry.grfInheritance = SUB_CONTAINERS_AND_OBJECTS_INHERIT;
  entry.Trustee.TrusteeForm = TRUSTEE_IS_SID;
  entry.Trustee.TrusteeType = TRUSTEE_IS_WELL_KNOWN_GROUP;
  entry.Trustee.ptstrName = (LPWSTR)sid;
  error_number = SetEntriesInAclW(1, &entry, NULL, &acl);
  if (error_number != ERROR_SUCCESS) return 0;
  error_number = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
    NULL, NULL, acl, NULL);
  (void)LocalFree(acl);
  return error_number == ERROR_SUCCESS;
}

static int check_rejected(const WCHAR *root, unsigned int index, PSID sid, ACCESS_MASK permissions) {
  WCHAR path[MAX_PATH];
  HANDLE handle = INVALID_HANDLE_VALUE;
  int written;
  int rejected;
  written = swprintf(path, sizeof(path) / sizeof(path[0]), L"%s\\case-%u", root, index);
  if (written <= 0 || (size_t)written >= sizeof(path) / sizeof(path[0]) || !CreateDirectoryW(path, NULL)) return 0;
  if (!configure_allow_ace(path, sid, permissions)) {
    (void)RemoveDirectoryW(path);
    return 0;
  }
  handle = CreateFileW(path, FILE_READ_ATTRIBUTES | READ_CONTROL, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) {
    (void)RemoveDirectoryW(path);
    return 0;
  }
  rejected = windows_private_security(handle) == 0;
  (void)CloseHandle(handle);
  (void)RemoveDirectoryW(path);
  return rejected;
}

int main(void) {
  WCHAR temp_path[MAX_PATH];
  WCHAR root[MAX_PATH];
  DWORD temp_length;
  PSID everyone = NULL;
  PSID users = NULL;
  int written;
  int passed = 0;
  temp_length = GetTempPathW(sizeof(temp_path) / sizeof(temp_path[0]), temp_path);
  if (temp_length == 0 || temp_length >= sizeof(temp_path) / sizeof(temp_path[0])) return 1;
  written = swprintf(root, sizeof(root) / sizeof(root[0]), L"%sdonwells-dacl-%lu", temp_path, (unsigned long)GetCurrentProcessId());
  if (written <= 0 || (size_t)written >= sizeof(root) / sizeof(root[0]) || !CreateDirectoryW(root, NULL)) return 1;
  if (!ConvertStringSidToSidW(L"S-1-1-0", &everyone) || !ConvertStringSidToSidW(L"S-1-5-32-545", &users)) goto cleanup;
  passed = check_rejected(root, 1, everyone, GENERIC_READ) &&
    check_rejected(root, 2, everyone, GENERIC_WRITE) &&
    check_rejected(root, 3, everyone, GENERIC_EXECUTE) &&
    check_rejected(root, 4, everyone, GENERIC_ALL) &&
    check_rejected(root, 6, everyone, FILE_DELETE_CHILD) &&
    check_rejected(root, 5, users, GENERIC_WRITE);
cleanup:
  if (everyone != NULL) (void)LocalFree(everyone);
  if (users != NULL) (void)LocalFree(users);
  (void)RemoveDirectoryW(root);
  if (!passed) return 1;
  (void)fputs("windows private DACL fixture passed\n", stdout);
  return 0;
}
