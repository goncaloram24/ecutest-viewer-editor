// Downloads the real ECU-TEST sample files listed in samples/SOURCES.md (pinned raw GitHub URLs).
// Most source repos carry no license, so those files are git-ignored: fetch them locally for testing only.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const samples = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'samples');
const lines = fs.readFileSync(path.join(samples, 'SOURCES.md'), 'utf8').split('\n');
let section = '';
let fetched = 0;
let kept = 0;
for (const line of lines) {
  const heading = /^## (.+)$/.exec(line);
  if (heading) section = heading[1].trim();
  const row = /^\| (.+?) \| \d+ \| (https:\/\/raw\.githubusercontent\.com\/\S+) \|$/.exec(line);
  if (!row || !section) continue;
  const target = path.join(samples, section, row[1]);
  if (fs.existsSync(target)) {
    kept++;
    continue;
  }
  const res = await fetch(row[2]);
  if (!res.ok) {
    console.warn(`skip ${row[2]}: HTTP ${res.status}`);
    continue;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, Buffer.from(await res.arrayBuffer()));
  fetched++;
}
console.log(`samples: ${fetched} downloaded, ${kept} already present`);
