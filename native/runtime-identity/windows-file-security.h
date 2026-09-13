#ifndef DONWELLS_WINDOWS_FILE_SECURITY_H
#define DONWELLS_WINDOWS_FILE_SECURITY_H

#include <aclapi.h>
#include <windows.h>

#include <stdlib.h>
#include <string.h>

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
  const ACCESS_MASK sensitive_access = FILE_GENERIC_READ | FILE_GENERIC_WRITE | FILE_GENERIC_EXECUTE |
    DELETE | FILE_DELETE_CHILD | READ_CONTROL | WRITE_DAC | WRITE_OWNER | ACCESS_SYSTEM_SECURITY | MAXIMUM_ALLOWED;
  GENERIC_MAPPING file_mapping;

  file_mapping.GenericRead = FILE_GENERIC_READ;
  file_mapping.GenericWrite = FILE_GENERIC_WRITE;
  file_mapping.GenericExecute = FILE_GENERIC_EXECUTE;
  file_mapping.GenericAll = FILE_ALL_ACCESS;
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
        ACCESS_MASK granted = ace->Mask;
        MapGenericMask(&granted, &file_mapping);
        if (!IsValidSid((PSID)&ace->SidStart) ||
            ((granted & sensitive_access) != 0 &&
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

#endif
