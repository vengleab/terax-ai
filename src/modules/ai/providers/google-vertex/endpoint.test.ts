import { describe, expect, it } from "vitest";
import {
  isValidLocation,
  isValidProject,
  LOCATION_SUGGESTIONS,
  vertexBaseUrl,
  vertexHost,
  vertexModelName,
} from "./endpoint";

describe("locations", () => {
  it("accepts global and real region names", () => {
    for (const ok of LOCATION_SUGGESTIONS) expect(isValidLocation(ok)).toBe(true);
    for (const ok of ["northamerica-northeast1", "southamerica-east1", "me-central2"]) {
      expect(isValidLocation(ok)).toBe(true);
    }
  });

  it("refuses anything that could change the host", () => {
    for (const bad of ["", "us-central1.evil.com", "evil.com/", "us central1", "us-central1:443", "GLOBAL", "us-central", "a@b", "../x"]) {
      expect(isValidLocation(bad)).toBe(false);
      expect(() => vertexBaseUrl("demo-project-123", bad)).toThrow(/not a valid Google Cloud location/);
    }
  });
});

describe("projects", () => {
  it("accepts ordinary and domain-scoped ids and rejects odd ones", () => {
    for (const ok of ["demo-project-123", "my-proj", "example.com:my-proj"]) expect(isValidProject(ok)).toBe(true);
    for (const bad of ["", "ab", "-bad", "has space", "a/b", "x?y=1", "a".repeat(101)]) expect(isValidProject(bad)).toBe(false);
  });
});

describe("vertexBaseUrl", () => {
  it("uses the global host for global and a regional host otherwise", () => {
    expect(vertexHost("global")).toBe("aiplatform.googleapis.com");
    expect(vertexHost("us-central1")).toBe("us-central1-aiplatform.googleapis.com");
    expect(vertexBaseUrl("demo-project-123", "global")).toBe(
      "https://aiplatform.googleapis.com/v1/projects/demo-project-123/locations/global/endpoints/openapi",
    );
    expect(vertexBaseUrl("demo-project-123", "europe-west4")).toBe(
      "https://europe-west4-aiplatform.googleapis.com/v1/projects/demo-project-123/locations/europe-west4/endpoints/openapi",
    );
  });

  it("encodes the project and rejects an invalid one", () => {
    expect(vertexBaseUrl("example.com:my-proj", "global")).toContain("/projects/example.com%3Amy-proj/");
    expect(() => vertexBaseUrl("bad project", "global")).toThrow(/not a valid Google Cloud project id/);
  });
});

describe("vertexModelName", () => {
  it("adds the google publisher prefix unless one is given", () => {
    expect(vertexModelName("gemini-2.5-flash")).toBe("google/gemini-2.5-flash");
    expect(vertexModelName("  gemini-2.5-pro ")).toBe("google/gemini-2.5-pro");
    expect(vertexModelName("meta/llama-3.3-70b-instruct-maas")).toBe("meta/llama-3.3-70b-instruct-maas");
  });

  it("asks for a model when none is set", () => {
    expect(() => vertexModelName("   ")).toThrow(/No Gemini model is set/);
  });
});
