#!/usr/bin/env node
import fs from 'fs';
import { DataFactory } from 'n3';

// Dynamically load n3 and resolve Parser/Store/Reasoner in a robust way
const n3mod = await import('n3');
const ParserCls = n3mod.Parser || (n3mod.default && n3mod.default.Parser);
const StoreCls = n3mod.Store || (n3mod.default && n3mod.default.Store);
const ReasonerCls = n3mod.Reasoner || (n3mod.default && n3mod.default.Reasoner) || (n3mod.default && n3mod.default);

// Quick helper to exit with message
function bail(msg, code = 2) {
  console.error(msg);
  process.exit(code);
}

if (!ParserCls || !StoreCls) {
  bail('Could not resolve Parser/Store from n3 module');
}

const rulesPath = 'public/reasoning-rules/default-rules.n3';

try {
  const rulesText = fs.readFileSync(rulesPath, 'utf8');

  // Parse rules exactly like example: parser.parse(rules)
  let parsedRules;
  try {
    const parser = new ParserCls({ format: 'text/n3' });
    parsedRules = parser.parse(rulesText);
    console.log('RULES_PARSE_OK quads=', parsedRules.length);
  } catch (parseErr) {
    console.error('RULES_PARSE_FAIL', parseErr && (parseErr.stack || parseErr.message) || parseErr);
    process.exit(3);
  }

  const rulesStore = new StoreCls(parsedRules);

  // Create a tiny test data store which exercises some rules:
  const { namedNode } = DataFactory;
  const ex = 'http://example.org/';
  const a = namedNode(ex + 'a');
  const B = namedNode(ex + 'B');
  const C = namedNode(ex + 'C');
  const rdfType = namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const rdfsSubClassOf = namedNode('http://www.w3.org/2000/01/rdf-schema#subClassOf');

  const dataStore = new StoreCls();
  dataStore.addQuad(DataFactory.quad(a, rdfType, B));
  dataStore.addQuad(DataFactory.quad(B, rdfsSubClassOf, C));

  if (!ReasonerCls) {
    console.warn('Reasoner export not found on n3 module; cannot run reasoner in test (but parser worked).');
    process.exit(0);
  }

  // Resolve constructor if ReasonerCls is a namespace/default wrapper
  let ReasonerImpl = ReasonerCls;
  if (typeof ReasonerImpl !== 'function' && ReasonerImpl && ReasonerImpl.default && typeof ReasonerImpl.default === 'function') {
    ReasonerImpl = ReasonerImpl.default;
  }

  if (typeof ReasonerImpl !== 'function') {
    console.error('REASONER_NOT_CONSTRUCTIBLE - resolved Reasoner is not a constructor, module keys:', Object.keys(n3mod));
    process.exit(4);
  }

  // Instantiate reasoner and run it
  try {
    const reasoner = new ReasonerImpl(dataStore);
    if (typeof reasoner.reason !== 'function') {
      console.error('REASONER_INSTANCE_HAS_NO_REASON_METHOD');
      process.exit(5);
    }
    reasoner.reason(rulesStore);
    console.log('REASONER_RUN_OK');
  } catch (rErr) {
    console.error('REASONER_RUN_FAIL', rErr && (rErr.stack || rErr.message) || rErr);
    process.exit(6);
  }

  // Inspect if inferred triple a rdf:type C exists
  const inferred = dataStore.getQuads(a, rdfType, C, null) || [];
  if (inferred.length > 0) {
    console.log('INFERENCE_DETECTED', inferred.length, inferred.map(q => `${q.subject.value} ${q.predicate.value} ${q.object.value}`));
    process.exit(0);
  } else {
    console.log('NO_INFERENCE_DETECTED - reasoner ran but no a rdf:type C found');
    const all = dataStore.getQuads(null, null, null, null) || [];
    console.log('STORE_QUADS_COUNT', all.length);
    all.forEach((q, i) => {
      console.log(`Q${i}:`, `${q.subject.value} ${q.predicate.value} ${q.object && q.object.value}`);
    });
    process.exit(0);
  }
} catch (e) {
  console.error('ERROR', e && (e.stack || e.message) || String(e));
  process.exit(2);
}
