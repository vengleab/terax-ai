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

export function parseSizeKb(value) {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(KB|MB)\s*$/i.exec(String(value));
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2].toUpperCase() === "MB" ? amount * 1024 : amount;
}

/**
 * Seams that live in JSON files, which cannot carry a marker comment.
 * Each budget asserts that a named size-limit entry is at least `minKb`.
 */
export function evaluateBudgets(config, files) {
  const errors = [];
  for (const budget of config.budgets ?? []) {
    const text = files.get(budget.file);
    if (text === undefined) {
      errors.push(`budget file is missing: ${budget.file}`);
      continue;
    }
    let entries;
    try {
      entries = JSON.parse(text);
    } catch {
      errors.push(`${budget.file}: not valid JSON`);
      continue;
    }
    const entry = Array.isArray(entries)
      ? entries.find((e) => e?.name === budget.name)
      : undefined;
    if (!entry) {
      errors.push(`${budget.file}: no entry named "${budget.name}"`);
      continue;
    }
    const kb = parseSizeKb(entry.limit);
    if (kb === undefined || kb < budget.minKb) {
      errors.push(
        `${budget.file}: "${budget.name}" limit is ${entry.limit}, the fork needs at least ${budget.minKb} KB (an upstream merge may have reverted it)`,
      );
    }
  }
  return errors;
}
