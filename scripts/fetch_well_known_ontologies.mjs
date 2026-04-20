#!/usr/bin/env node
/**
 * Fetch well-known ontologies and serialize them to Turtle.
 *
 * This script:
 *  - Reads src/utils/wellKnownOntologies.ts and extracts WELL_KNOWN_PREFIXES entries
 *  - For each entry, fetches the ontology URL (with Accept headers)
 *  - Parses whatever RDF format is returned using rdf-parse
 *  - Serializes the resulting quad stream to Turtle using rdf-serialize
 *  - Writes output to scripts/outputs/<prefix or sanitized-url>.ttl
 *
 * Note: this script is intentionally standalone and does not import the TypeScript module
 * directly to avoid needing TS transpilation. It extracts prefix+url pairs via a simple
 * source-text parse.
 */

import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { StreamParser } from 'n3';
import { rdfSerializer } from 'rdf-serialize';
import getStream from 'get-stream';
import { Readable } from 'stream';

// parsers we will use for specific formats
import jsonld from 'jsonld';
import { RdfXmlParser } from 'rdfxml-streaming-parser';

/**
 * Helper: produce an RDF/JS quad stream for the given input stream / text.
 * Handles common formats: Turtle/N-Triples (stream parser), RDF/XML (rdfxml-streaming-parser),
 * JSON-LD (convert to N-Quads via jsonld).
 */
function streamFromString(text) {
  return Readable.from([text]);
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WELL_KNOWN_TS = path.join(__dirname, '..', 'src', 'utils', 'wellKnownOntologies.ts');
const OUTPUT_DIR = path.join(__dirname, 'outputs');

function sanitizeFileName(s) {
  return s.replace(/[^a-z0-9\-_\.]/gi, '_');
}

async function extractPrefixesAndUrls() {
  const src = await fs.readFile(WELL_KNOWN_TS, 'utf8');
  // Find the WELL_KNOWN_PREFIXES array block
  const start = src.indexOf('export const WELL_KNOWN_PREFIXES');
  if (start === -1) throw new Error('WELL_KNOWN_PREFIXES not found in wellKnownOntologies.ts');
  const arrayStart = src.indexOf('[', start);
  if (arrayStart === -1) throw new Error('Cannot find array start');
  // Find matching closing bracket (simple bracket counting)
  let idx = arrayStart;
  let depth = 0;
  while (idx < src.length) {
    const ch = src[idx];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) {
        break;
      }
    }
    idx++;
  }
  const arrayText = src.slice(arrayStart, idx + 1);
  // Match object entries and capture prefix and url
  const objRe = /{([\s\S]*?)}/g;
  const entries = [];
  let m;
  while ((m = objRe.exec(arrayText)) !== null) {
    const objText = m[1];
    // find prefix: '...' or "..."
    const prefixMatch = objText.match(/prefix\s*:\s*['"]([^'"]+)['"]/);
    const urlMatch = objText.match(/url\s*:\s*['"]([^'"]+)['"]/);
    const nameMatch = objText.match(/name\s*:\s*['"]([^'"]+)['"]/);
    if (urlMatch) {
      entries.push({
        prefix: prefixMatch ? prefixMatch[1] : null,
        url: urlMatch[1],
        name: nameMatch ? nameMatch[1] : null,
      });
    }
  }
  return entries;
}

async function fetchAndSerialize(entry) {
  const { prefix, url, name } = entry;
  console.log(`\n----\nProcessing: ${prefix || '(no-prefix)'} -> ${url} (${name || 'no-name'})`);
  try {
    const accept = 'text/turtle, application/trig, application/n-quads, application/n-triples, application/ld+json, application/rdf+xml, text/n3, */*';
    const res = await fetch(url, { headers: { Accept: accept } , redirect: 'follow' });
    if (!res) throw new Error(`No response for ${url}`);
    if (!res.ok) {
      console.warn(`Warning: HTTP ${res.status} ${res.statusText} for ${url}`);
    }
    const contentTypeHeader = res.headers.get('content-type') || null;
    console.log(`Content-Type: ${contentTypeHeader || 'unknown'}`);
    // rdf-parse expects a Node.js stream or string. res.body is usually a stream.
    let inputStream = res.body;
    let usedString = false;
    if (!inputStream) {
      // fallback: use text
      const txt = await res.text();
      inputStream = Readable.from([txt]);
      usedString = true;
    }

    // Parse into quadStream based on detected content type / heuristics
    let quadStream;
    const ct = (contentTypeHeader || '').toLowerCase();

    if ((ct.includes('json') && ct.includes('ld')) || (/^\s*\{/.test(String(await (usedString ? '' : (await (async () => { const tmp = await res.clone().text(); return tmp; })())))) && (contentTypeHeader || '').toLowerCase().includes('json'))) {
      // JSON-LD path: convert to N-Quads via jsonld, then parse with StreamParser (N-Quads)
      let txt = '';
      if (!usedString) txt = await res.text();
      else txt = (await getStream(inputStream));
      let parsedJson;
      try {
        parsedJson = JSON.parse(txt);
      } catch (_) {
        parsedJson = txt;
      }
      const nquads = await jsonld.toRDF(parsedJson, { format: 'application/n-quads' });
      quadStream = streamFromString(nquads).pipe(new StreamParser({ format: 'N-Quads', baseIRI: url }));
    } else if (ct.includes('xml') || /^\s*<\?xml/i.test(await (usedString ? (await getStream(inputStream)) : (await res.clone().text())))) {
      // RDF/XML path: use rdfxml-streaming-parser which returns a stream of quads
      const xmlParser = new RdfXmlParser({ baseIRI: url });
      // If inputStream is a Reader, pipe it; if it's a string stream, just pass through
      try {
        quadStream = inputStream.pipe(xmlParser);
      } catch (_) {
        const txt = await res.text();
        quadStream = streamFromString(txt).pipe(xmlParser);
      }
    } else {
      // Default: assume Turtle/N-Triples/etc. Use N3 StreamParser which can auto-detect many formats.
      try {
        quadStream = inputStream.pipe(new StreamParser({ baseIRI: url }));
      } catch (_) {
        // fallback to parsing from text
        const txt = await res.text();
        quadStream = streamFromString(txt).pipe(new StreamParser({ baseIRI: url }));
      }
    }

    // Serialize quad stream to Turtle using rdf-serialize's rdfSerializer
    const prefixes = {};
    if (prefix && url) prefixes[prefix] = url;
    const textStream = rdfSerializer.serialize(quadStream, { contentType: 'text/turtle', prefixes });

    // collect Turtle text
    const ttl = await getStream(textStream);

    // ensure output dir exists
    await fs.mkdir(OUTPUT_DIR, { recursive: true });

    const outName = prefix ? `${sanitizeFileName(prefix)}.ttl` : `${sanitizeFileName(url)}.ttl`;
    const outPath = path.join(OUTPUT_DIR, outName);
    await fs.writeFile(outPath, ttl, 'utf8');
    console.log(`Wrote Turtle to ${outPath} (len=${ttl.length})`);
  } catch (err) {
    console.error(`Failed processing ${url}:`, String(err));
  }
}

async function main() {
  console.log('Fetching well-known ontologies (from src/utils/wellKnownOntologies.ts)');
  const entries = await extractPrefixesAndUrls();
  console.log(`Found ${entries.length} entries.`);
  for (const e of entries) {
    await fetchAndSerialize(e);
  }
  console.log('\\nDone.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
