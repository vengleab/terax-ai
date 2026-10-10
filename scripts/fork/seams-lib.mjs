export const SEAM_MARKER = "fork:ssh-transfer";

export function countMarker(text, marker = SEAM_MARKER) {
  if (!text) return 0;
  return text.split(marker).length - 1;
}

export function isOwnedPath(path, ownedPrefixes) {
  return ownedPrefixes.some((prefix) =>
    prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix,
  );
}

export function evaluateSeams(config, files) {
  const marker = config.marker ?? SEAM_MARKER;
  const errors = [];
  const registered = new Set();

  for (const seam of config.seams) {
    registered.add(seam.file);
    const text = files.get(seam.file);
    if (text === undefined) {
      errors.push(`seam file is missing: ${seam.file}`);
      continue;
    }
    const found = countMarker(text, marker);
    if (found < seam.min) {
      errors.push(
        `${seam.file}: expected at least ${seam.min} "${marker}" marker(s), found ${found}`,
      );
    }
    if (seam.max !== undefined && found > seam.max) {
      errors.push(
        `${seam.file}: expected at most ${seam.max} "${marker}" marker(s), found ${found}`,
      );
    }
  }

  for (const [path, text] of files) {
    if (registered.has(path) || isOwnedPath(path, config.ownedPrefixes)) {
      continue;
    }
    if (countMarker(text, marker) > 0) {
      errors.push(`${path}: unregistered "${marker}" marker (add it to seams.json)`);
    }
  }

  return errors;
}
