import {
  parseMarkdownBlock,
  initMarkdownPipeline,
} from "../markdownPipeline";

export type WorkerParseRequest = {
  requestId: number;
  blocks: Array<{ index: number; content: string; hash: string }>;
  dirtyIndices: number[];
};

export type WorkerParseResponse = {
  requestId: number;
  results: Array<{ index: number; hash: string; html: string }>;
};

initMarkdownPipeline();

self.onmessage = (event: MessageEvent<WorkerParseRequest>) => {
  const { requestId, blocks, dirtyIndices } = event.data;
  const blockByIndex = new Map(blocks.map((block) => [block.index, block]));
  const results: WorkerParseResponse["results"] = [];

  for (const index of dirtyIndices) {
    const block = blockByIndex.get(index);
    if (!block) continue;
    const html = parseMarkdownBlock(block.content);
    results.push({ index: block.index, hash: block.hash, html });
  }

  const response: WorkerParseResponse = { requestId, results };
  self.postMessage(response);
};
