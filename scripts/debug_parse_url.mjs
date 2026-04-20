import fetch from 'node-fetch';
import getStream from 'get-stream';
import { Readable } from 'stream';

(async () => {
  const urls = [
    'https://www.w3.org/ns/org#',
    'https://w3id.org/pmd/co/',
    'https://xmlns.com/foaf/0.1/'
  ];

  const rdfParseMod = await import('rdf-parse').catch((e) => { console.error('import rdf-parse failed', e); process.exit(2); });
  const rdfSerializeMod = await import('rdf-serialize').catch((e) => { console.error('import rdf-serialize failed', e); process.exit(2); });

  const parseFn = rdfParseMod.parse || (rdfParseMod.default && rdfParseMod.default.parse) || rdfParseMod.rdfParser || rdfParseMod.default || rdfParseMod;
  const serializeFn = rdfSerializeMod.serialize || (rdfSerializeMod.default && rdfSerializeMod.default.serialize) || rdfSerializeMod.rdfSerializer || rdfSerializeMod.default || rdfSerializeMod;

  for (const url of urls) {
    try {
      console.log('\\n----\\nFetching', url);
      const res = await fetch(url, { headers: { Accept: 'text/turtle, application/ld+json, application/rdf+xml, */*' }, redirect: 'follow' });
      console.log('status', res.status, 'content-type', res.headers.get('content-type'));
      const txt = await res.text();
      console.log('fetched length', txt.length);
      const input = Readable.from([txt]);

      console.log('[DEBUG] invoking parse');
      const quadStream = parseFn(input, { contentType: res.headers.get('content-type') || undefined, baseIRI: url });

      // consume async iterable to collect quads and print a few
      const collected = [];
      let count = 0;
      for await (const q of quadStream) {
        count++;
        if (collected.length < 6) {
          try {
            collected.push({
              s: q.subject && q.subject.value,
              p: q.predicate && q.predicate.value,
              o: q.object && (q.object.value || q.object.id),
            });
          } catch (_) { collected.push(String(q)); }
        }
      }
      console.log('[DEBUG] parsed quad count:', count);
      console.log('[DEBUG] sample quads:', collected);

      // Try serializing collected quads to Turtle
      try {
        const quadIterable = (async function* () {
          for (const q of collected) {
            // collected currently contains plain objects; to get a proper serialization
            // reparse the original txt using N3 Writer would be complex.
            // Instead, re-run parse and pipe to serialize for a clean run.
          }
        })();

        // Re-run parsing and pipe to serializer for a proper Turtle output
        const reInput = Readable.from([txt]);
        const reQuadStream = parseFn(reInput, { contentType: res.headers.get('content-type') || undefined, baseIRI: url });
        const textStream = serializeFn(reQuadStream, { contentType: 'text/turtle' });
        const turtle = await getStream(textStream);
        console.log('[DEBUG] serialized turtle length:', (turtle || '').length);
        console.log('[DEBUG] turtle preview:', (turtle || '').slice(0, 400));
      } catch (serErr) {
        console.error('[DEBUG] serialization failed', serErr && serErr.stack ? serErr.stack : String(serErr));
      }

    } catch (err) {
      console.error('Error processing', url, err && err.stack ? err.stack : String(err));
    }
  }

  console.log('\\nDone.');
  process.exit(0);
})();
