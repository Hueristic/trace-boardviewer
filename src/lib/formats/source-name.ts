/**
 * The name of a source file as the readers see it. A file read from the disk follows the platform's separators: on win32 both
 * separators split the directories, elsewhere only the slash does, because a backslash is an ordinary character of a POSIX file name.
 * Two cases keep both separators on every platform: an archive entry name (Windows tools write a backslash into a zip), and any input
 * whose platform is not known. An undefined platform is that rule, the one every reader used before the platform was passed in.
 *
 * This module has no imports, so the readers can use it without an import cycle; adapter.ts re-exports it.
 */
export type SourcePlatform = 'win32' | 'darwin' | 'linux' | 'other';

const bothSeparators = (platform: SourcePlatform | undefined): boolean => platform === undefined || platform === 'win32';

/** The file name: the part after the last directory separator, or the whole name when there is none. */
export function sourceBaseName(name: string, platform?: SourcePlatform): string {
  const separator = bothSeparators(platform) ? Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) : name.lastIndexOf('/');
  return name.slice(separator + 1);
}

/** The components of a name, split at the separators that count on the platform (the same rule as sourceBaseName). */
export function sourceSegments(name: string, platform?: SourcePlatform): string[] {
  return name.split(bothSeparators(platform) ? /[\\/]/ : '/');
}
