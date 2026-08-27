import { userInfo } from "node:os";

/**
 * The user name of the account this process runs as.
 *
 * Isolated in a module of its own for two reasons. The call THROWS
 * (`ERR_SYSTEM_ERROR`, `uv_os_get_passwd returned ENOENT`) rather than returning
 * nothing when the account has no entry in the user database -- what a container
 * run under `--user <uid>:<gid>` naming a uid the image does not define produces,
 * in the musl and glibc images alike -- so the one call site keeps the throw
 * where a single caller handles it. And keeping it out of the modules that
 * resolve an identity lets a test substitute a throwing or absent user name
 * without mocking `node:os` for a whole file.
 */
export function accountUserName(): string {
  return userInfo().username;
}
