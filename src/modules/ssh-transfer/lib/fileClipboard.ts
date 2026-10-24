import type { EndpointRef, TransferMode } from "../types";

export type FileClipboard = {
  endpoint: EndpointRef;
  parent: string;
  paths: string[];
  mode: TransferMode;
};

let current: FileClipboard | null = null;

export function setFileClipboard(value: FileClipboard | null): void {
  current = value;
}

export function getFileClipboard(): FileClipboard | null {
  return current;
}
