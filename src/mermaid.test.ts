// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const render = vi.fn(async (id: string) => ({
  svg:
    `<svg id="${id}" aria-labelledby="chart-title-${id}"><style>#${id} .edge{stroke:#333}</style>` +
    `<title id="chart-title-${id}">t</title>` +
    `<defs><marker id="${id}_pointEnd"><path/></marker><marker id="arrowhead"><path/></marker></defs>` +
    `<path class="edge" marker-end="url(#${id}_pointEnd)" style="filter:url('#arrowhead')"/>` +
    `<use href="#arrowhead"/></svg>`,
}));
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render } }));

import { renderMermaidBlocks } from "./mermaid";
import { closeMermaidZoom, openMermaidZoom, uniquifySvgIds } from "./mermaid-zoom";

function placeholder(src: string): string {
  return `<pre class="mermaid-block">${src}</pre>`;
}

// Every id-reference in `svg` must resolve to an element inside that same svg.
function referencesStayInside(svg: SVGElement): void {
  const ids = new Set(Array.from(svg.querySelectorAll("[id]"), (el) => el.id).concat(svg.id));
  const refs: string[] = [];
  for (const el of [svg, ...Array.from(svg.querySelectorAll("*"))]) {
    for (const attr of Array.from(el.attributes)) {
      for (const m of attr.value.matchAll(/url\(['"]?#([^'")]+)/g)) refs.push(m[1]);
      if (attr.localName === "href" && attr.value.startsWith("#")) refs.push(attr.value.slice(1));
      if (attr.name === "aria-labelledby") refs.push(attr.value);
    }
  }
  const css = svg.querySelector("style")?.textContent ?? "";
  refs.push(/#([\w-]+) \.edge/.exec(css)![1]);
  expect(refs.length).toBe(5);
  for (const ref of refs) expect(ids, ref).toContain(ref);
}

describe("mermaid diagram ids", () => {
  afterEach(() => {
    closeMermaidZoom();
    document.body.innerHTML = "";
  });

  it("gives identical diagrams, fresh and cached, their own ids", async () => {
    const root = document.createElement("div");
    root.innerHTML = placeholder("graph TD; A-->B") + placeholder("graph TD; A-->B");
    document.body.appendChild(root);
    await renderMermaidBlocks(root, "light-test", "light");
    root.insertAdjacentHTML("beforeend", placeholder("graph TD; A-->B"));
    await renderMermaidBlocks(root, "light-test", "light");

    const svgs = Array.from(root.querySelectorAll<SVGElement>(".mermaid-diagram svg"));
    expect(svgs).toHaveLength(3);
    const all = Array.from(root.querySelectorAll("[id]"), (el) => el.id);
    expect(new Set(all).size).toBe(all.length);
    svgs.forEach(referencesStayInside);
  });

  it("gives the zoom clone its own ids", async () => {
    const root = document.createElement("div");
    root.innerHTML = placeholder("graph LR; X-->Y");
    document.body.appendChild(root);
    await renderMermaidBlocks(root, "light-test", "light");
    const diagram = root.querySelector<HTMLElement>(".mermaid-diagram")!;
    openMermaidZoom(diagram);

    const clone = document.querySelector<SVGElement>(".mermaid-zoom-stage svg")!;
    const original = diagram.querySelector("svg")!;
    expect(clone.id).not.toBe(original.id);
    const all = Array.from(document.querySelectorAll("[id]"), (el) => el.id);
    expect(new Set(all).size).toBe(all.length);
    referencesStayInside(clone);
    referencesStayInside(original);
  });

  it("renames ids in style selectors but leaves colours that look like ids", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<svg id="d"><style>#d .node{fill:#fff;stroke:url(#g)} #fff{opacity:1}</style>' +
      '<g id="fff"></g><linearGradient id="g"></linearGradient></svg>';
    uniquifySvgIds(host.querySelector("svg")!);
    const css = host.querySelector("style")!.textContent!;
    const id = (old: string) => host.querySelector(`[id^="${old}-g"]`)!.id;
    expect(css).toContain(`#${id("d")} .node{fill:#fff;stroke:url(#${id("g")})}`);
    expect(css).toContain(`#${id("fff")}{opacity:1}`);
  });
});
