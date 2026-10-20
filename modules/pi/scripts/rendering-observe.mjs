// Observe existing production component renders. No component output is changed.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
const source = realpathSync(
  new URL(
    "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/tool-execution.js",
    import.meta.url,
  ),
);
registerHooks({
  load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (url !== pathToFileURL(source).href) return result;
    let text = String(result.source);
    const changes = [
      [
        "createResultRegion(component) {",
        `createResultRegion(component, phase) {
      const original=component.render.bind(component);
      const owner=this;
      component=new Proxy(component,{get(target,key,receiver){
        if(key==='render') return width=>{
          const lines=original(width);
          globalThis.__piRenderingObservation?.({toolCallId:owner.toolCallId,phase,width,expanded:owner.expanded,isPartial:owner.isPartial,lines});
          return phase==='result'&&process.env.PI_RENDER_DROP_RESULTS==='1'?[]:lines;
        };
        return Reflect.get(target,key,receiver);
      }});`,
      ],
      [
        "this.createResultRegion(this.createCallFallback())",
        'this.createResultRegion(this.createCallFallback(), "call")',
      ],
      [
        "this.callRendererComponent = component;\n                    renderContainer.addChild(this.createResultRegion(component));",
        'this.callRendererComponent = component;\n                    renderContainer.addChild(this.createResultRegion(component, "call"));',
      ],
      [
        "this.createResultRegion(component)",
        'this.createResultRegion(component, "result")',
      ],
    ];
    for (const [before, after] of changes) {
      assert.ok(
        text.includes(before),
        "render observation source contract changed: " + before,
      );
      text = text.replaceAll(before, after);
    }
    writeFileSync(process.env.PI_RENDER_OBSERVED_SOURCE, text);
    return { ...result, source: text };
  },
});
