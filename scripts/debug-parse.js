import fs from 'fs';
import { fileURLToPath } from 'url';

(async () => {
  try {
    const { parseRDFFile } = await import('../src/utils/rdfParser.js');
    const demo = `
      @prefix : <https://github.com/Mat-O-Lab/IOFMaterialsTutorial/> .
      @prefix iof: <https://spec.industrialontologies.org/ontology/core/Core/> .
      @prefix iof-qual: <https://spec.industrialontologies.org/ontology/qualities/> .
      @prefix iof-mat: <https://spec.industrialontologies.org/ontology/materials/Materials/> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .

      :SpecimenLength a iof-qual:Length ;
          iof:masuredByAtSomeTime :Caliper .

      :Caliper a iof-mat:MeasurementDevice .
    `;
    const parsed = await parseRDFFile(demo, (p,m)=>{ console.log('progress',p,m); });
    console.log('Parsed nodes count:', parsed.nodes.length);
    console.log(JSON.stringify(parsed.nodes, null, 2));
    console.log('Parsed edges count:', parsed.edges.length);
    console.log(JSON.stringify(parsed.edges, null, 2));
    console.log('Prefixes:', parsed.prefixes);
    console.log('Namespaces:', parsed.namespaces);
  } catch (e) {
    console.error('Error during debug parse:', e);
    process.exit(1);
  }
})();
