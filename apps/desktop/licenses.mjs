import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function bundledNotices(inputs, renderer) {
  const packages = new Map();
  for (const input of inputs) {
    let directory = dirname(resolve(input));
    while (true) {
      const path = join(directory, 'package.json');
      let metadata;
      try {
        metadata = JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
      if (metadata?.name && metadata?.version) {
        if (metadata.name.startsWith('@windows-ai-notes/')) break;
        const key = `${metadata.name}@${metadata.version}`;
        if (packages.has(key)) break;
        if (typeof metadata.license !== 'string')
          throw new Error(
            `Missing license identifier for bundled dependency ${key}.`,
          );
        const files = (await readdir(directory, { withFileTypes: true }))
          .filter(
            (file) =>
              file.isFile() &&
              /^(licen[cs]e|copying|notice)([._-].*)?$/i.test(file.name),
          )
          .map((file) => file.name)
          .sort();
        if (!files.length)
          throw new Error(
            `Missing license text for bundled dependency ${key}.`,
          );
        const texts = await Promise.all(
          files.map((file) => readFile(join(directory, file), 'utf8')),
        );
        packages.set(key, {
          name: metadata.name,
          version: metadata.version,
          identifier: metadata.license,
          text: texts.join('\n\n'),
        });
        break;
      }
      const parent = dirname(directory);
      if (parent === directory)
        throw new Error(`Cannot identify the package containing ${input}.`);
      directory = parent;
    }
  }
  if (!Array.isArray(renderer))
    throw new Error('Vite did not produce the documented license metadata.');
  for (const item of renderer) {
    if (!item || typeof item.name !== 'string')
      throw new Error('Vite returned invalid dependency license metadata.');
    if (item.name.startsWith('@windows-ai-notes/')) continue;
    if (
      !item.name ||
      typeof item.version !== 'string' ||
      typeof item.identifier !== 'string' ||
      !item.identifier ||
      typeof item.text !== 'string' ||
      !item.text.trim()
    )
      throw new Error(`Missing renderer dependency notice for ${item.name}.`);
    const key = `${item.name}@${item.version}`;
    if (!packages.has(key)) packages.set(key, item);
  }
  return (
    'Windows AI Notes - bundled JavaScript dependency notices\n\n' +
    [...packages.entries()]
      .sort(([a], [b]) => a.localeCompare(b, 'en'))
      .map(
        ([key, item]) =>
          `${key}\nLicense: ${item.identifier}\n\n${item.text.trim()}\n`,
      )
      .join('\n----------------------------------------\n\n')
  );
}
