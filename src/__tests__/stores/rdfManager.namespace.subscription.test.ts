// @vitest-environment node
import { describe, test, expect, beforeEach } from "vitest";
import { initRdfManagerWorker } from "../utils/initRdfManagerWorker";
import { rdfManager } from "../../utils/rdfManager";
import type { NamespaceEntry } from "../../constants/namespaces";

describe("RDFManagerImpl namespace subscription", () => {
  beforeEach(async () => {
    await initRdfManagerWorker();
    rdfManager.clear();
    rdfManager.setNamespaces({}, { replace: true });
    await new Promise(resolve => setTimeout(resolve, 100));
  });

  test("onNamespacesChange fires after addNamespace", async () => {
    const snapshots: NamespaceEntry[][] = [];
    const unsub = rdfManager.onNamespacesChange((entries) => snapshots.push([...entries]));
    try {
      rdfManager.addNamespace("sub-test", "http://subscription-test.example.com/");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(snapshots.length).toBeGreaterThan(0);
      const last = snapshots[snapshots.length - 1];
      const entry = last.find(e => e.prefix === "sub-test");
      expect(entry).toBeDefined();
      expect(entry!.uri).toBe("http://subscription-test.example.com/");
    } finally {
      unsub();
    }
  });

  test("onNamespacesChange fires after removeNamespace", async () => {
    rdfManager.addNamespace("to-remove", "http://to-remove.example.com/");
    await new Promise(resolve => setTimeout(resolve, 50));
    const snapshots: NamespaceEntry[][] = [];
    const unsub = rdfManager.onNamespacesChange((entries) => snapshots.push([...entries]));
    try {
      rdfManager.removeNamespace("to-remove");
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(snapshots.length).toBeGreaterThan(0);
      const last = snapshots[snapshots.length - 1];
      expect(last.find(e => e.prefix === "to-remove")).toBeUndefined();
    } finally {
      unsub();
    }
  });

  test("getNamespaces returns NamespaceEntry[]", () => {
    rdfManager.addNamespace("ns-get-test", "http://ns-get-test.example.com/");
    const entries = rdfManager.getNamespaces();
    expect(Array.isArray(entries)).toBe(true);
    const entry = entries.find(e => e.prefix === "ns-get-test");
    expect(entry).toBeDefined();
    expect(entry!.uri).toBe("http://ns-get-test.example.com/");
  });

  test("unsub stops notifications", async () => {
    const snapshots: NamespaceEntry[][] = [];
    const unsub = rdfManager.onNamespacesChange((entries) => snapshots.push([...entries]));
    unsub();
    rdfManager.addNamespace("after-unsub", "http://after-unsub.example.com/");
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(snapshots.length).toBe(0);
  });
});
