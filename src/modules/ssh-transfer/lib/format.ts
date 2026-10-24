const UNITS = ["B", "KB", "MB", "GB", "TB"];

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

export function formatSpeed(bytesPerSec: number): string {
  return bytesPerSec > 0 ? `${formatBytes(bytesPerSec)}/s` : "";
}

export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return "";
  const seconds = Math.round(totalSeconds);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export function formatMtime(secs: number | null, now = Date.now()): string {
  if (secs == null) return "";
  const date = new Date(secs * 1000);
  const age = now - date.getTime();
  const sixMonths = 1000 * 60 * 60 * 24 * 182;
  const options: Intl.DateTimeFormatOptions =
    Math.abs(age) < sixMonths
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
      : { year: "numeric", month: "short", day: "numeric" };
  return date.toLocaleString(undefined, options);
}

/** `rwxr-xr-x` for the nine permission bits. */
export function formatMode(mode: number | null): string {
  if (mode == null) return "";
  const bit = (mask: number, ch: string) => (mode & mask ? ch : "-");
  return (
    bit(0o400, "r") + bit(0o200, "w") + bit(0o100, "x") +
    bit(0o040, "r") + bit(0o020, "w") + bit(0o010, "x") +
    bit(0o004, "r") + bit(0o002, "w") + bit(0o001, "x")
  );
}

export function modeToOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, "0");
}

/** Parses 3 or 4 octal digits. Returns null for anything else. */
export function parseOctalMode(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-7]{3,4}$/.test(trimmed)) return null;
  return Number.parseInt(trimmed, 8);
}
