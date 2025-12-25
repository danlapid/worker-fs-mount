/**
 * Error codes used by the filesystem.
 */
export type FsErrorCode =
  | 'ENOENT'
  | 'EEXIST'
  | 'EISDIR'
  | 'ENOTDIR'
  | 'ENOTEMPTY'
  | 'EINVAL'
  | 'ELOOP';

/**
 * Error messages for each error code.
 */
const ERROR_MESSAGES: Record<FsErrorCode, string> = {
  ENOENT: 'no such file or directory',
  EEXIST: 'file already exists',
  EISDIR: 'illegal operation on a directory',
  ENOTDIR: 'not a directory',
  ENOTEMPTY: 'directory not empty',
  EINVAL: 'invalid argument',
  ELOOP: 'too many symbolic links',
};

/**
 * Create a filesystem error with a POSIX-style error code.
 * @param code - The error code (ENOENT, EEXIST, etc.)
 * @param path - The path that caused the error
 * @returns An Error with the formatted message
 */
export function createFsError(code: FsErrorCode, path: string): Error {
  const message = ERROR_MESSAGES[code];
  return new Error(`${code}: ${message}, '${path}'`);
}
