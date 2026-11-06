#define NAPI_VERSION 8
#include <node_api.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#ifdef _WIN32
#include <windows.h>
/* Resolve Node-API from the host so both node.exe and renamed Electron apps work. */
#define NODE_API_FUNCTIONS(X) \
  X(napi_get_cb_info, (napi_env, napi_callback_info, size_t *, napi_value *, napi_value *, void **)) \
  X(napi_throw_type_error, (napi_env, const char *, const char *)) \
  X(napi_get_value_string_utf16, (napi_env, napi_value, char16_t *, size_t, size_t *)) \
  X(napi_get_boolean, (napi_env, bool, napi_value *)) \
  X(napi_throw_error, (napi_env, const char *, const char *)) \
  X(napi_create_function, (napi_env, const char *, size_t, napi_callback, void *, napi_value *)) \
  X(napi_set_named_property, (napi_env, napi_value, const char *, napi_value))
#define DECLARE_NODE_API(name, args) static napi_status (NAPI_CDECL *win_##name) args;
NODE_API_FUNCTIONS(DECLARE_NODE_API)
#define napi_get_cb_info win_napi_get_cb_info
#define napi_throw_type_error win_napi_throw_type_error
#define napi_get_value_string_utf16 win_napi_get_value_string_utf16
#define napi_get_boolean win_napi_get_boolean
#define napi_throw_error win_napi_throw_error
#define napi_create_function win_napi_create_function
#define napi_set_named_property win_napi_set_named_property
#else
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#include <errno.h>
#endif

/* No unlock export and no GC finalizer: the OS owns release at process death.
 * Handles are not inherited by spawned browser processes. Never unlink the file.
 */
static napi_value acquire(napi_env env, napi_callback_info info) {
  size_t argc = 1, length = 0;
  napi_value arg, result;
  if (napi_get_cb_info(env, info, &argc, &arg, NULL, NULL) != napi_ok || argc != 1) {
    napi_throw_type_error(env, NULL, "Expected lock file path"); return NULL;
  }
#ifdef _WIN32
  if (napi_get_value_string_utf16(env, arg, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected lock file path"); return NULL;
  }
  wchar_t *path = calloc(length + 1, sizeof(wchar_t));
#else
  if (napi_get_value_string_utf8(env, arg, NULL, 0, &length) != napi_ok) {
    napi_throw_type_error(env, NULL, "Expected lock file path"); return NULL;
  }
  char *path = calloc(length + 1, 1);
#endif
  if (!path) { napi_throw_error(env, NULL, "Lock allocation failed"); return NULL; }
#ifdef _WIN32
  napi_get_value_string_utf16(env, arg, (char16_t *)path, length + 1, &length);
  HANDLE file = CreateFileW(path, GENERIC_READ | GENERIC_WRITE,
      FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
  free(path);
  if (file == INVALID_HANDLE_VALUE) {
    napi_throw_error(env, "RUNTIME_LOCK_IO", "Cannot open runtime lock"); return NULL;
  }
  OVERLAPPED range = {0};
  if (!LockFileEx(file, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &range)) {
    DWORD error = GetLastError(); CloseHandle(file);
    if (error == ERROR_LOCK_VIOLATION) { napi_get_boolean(env, false, &result); return result; }
    napi_throw_error(env, "RUNTIME_LOCK_IO", "Cannot acquire runtime lock"); return NULL;
  }
#else
  napi_get_value_string_utf8(env, arg, path, length + 1, &length);
  int file = open(path, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
  free(path);
  if (file < 0) { napi_throw_error(env, "RUNTIME_LOCK_IO", strerror(errno)); return NULL; }
  if (flock(file, LOCK_EX | LOCK_NB) != 0) {
    int error = errno; close(file);
    if (error == EWOULDBLOCK || error == EAGAIN) { napi_get_boolean(env, false, &result); return result; }
    napi_throw_error(env, "RUNTIME_LOCK_IO", "Cannot acquire runtime lock"); return NULL;
  }
#endif
  napi_get_boolean(env, true, &result); return result;
}
NAPI_MODULE_INIT() {
#ifdef _WIN32
  HMODULE host = GetModuleHandleW(NULL);
#define LOAD_NODE_API(name, args) { \
    FARPROC symbol = GetProcAddress(host, #name); \
    if (!symbol) return NULL; \
    memcpy(&win_##name, &symbol, sizeof(symbol)); \
  }
  NODE_API_FUNCTIONS(LOAD_NODE_API)
#endif
  napi_value fn;
  napi_create_function(env, "acquire", NAPI_AUTO_LENGTH, acquire, NULL, &fn);
  napi_set_named_property(env, exports, "acquire", fn);
  return exports;
}
