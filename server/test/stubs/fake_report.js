// Stand-in for agent/make_report.py in tests: argv = [dataPath, pdfPath].
// Writes a fake PDF so the report endpoint has a file to serve.
import fs from 'node:fs';

const [, , dataPath, pdfPath] = process.argv;
JSON.parse(fs.readFileSync(dataPath, 'utf8')); // dies if the server wrote bad JSON
fs.writeFileSync(pdfPath, '%PDF-1.4 fake report for tests\n');
process.exit(0);
