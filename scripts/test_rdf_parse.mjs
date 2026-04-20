import rdfParse from 'rdf-parse';
import rdfSerialize from 'rdf-serialize';
import getStream from 'get-stream';
import { Readable } from 'stream';

(async () => {
  try {
    const turtle = `@prefix ex: <http://example.org/> .
ex:sub ex:pred "obj" .`;
    const input = Readable.from([turtle]);
    console.log("[TEST] Invoking rdf-parse on sample Turtle");
    const quadStream = (rdfParse && (rdfParse.parse || rdfParse.default || rdfParse))(input, { contentType: 'text/turtle' });
    console.log("[TEST] Serializing quad stream to Turtle via rdf-serialize");
    const textStream = (rdfSerialize && (rdfSerialize.serialize || rdfSerialize.default || rdfSerialize))(quadStream, { contentType: 'text/turtle' });
    const out = await getStream(textStream);
    console.log("[TEST] Output length:", (out || "").length);
    console.log("[TEST] Output preview:\\n", (out || "").slice(0, 500));
    process.exit(0);
  } catch (err) {
    console.error("[TEST] rdf-parse pipeline error:", err && err.stack ? err.stack : String(err));
    process.exit(2);
  }
})();
