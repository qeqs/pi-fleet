// A pi extension for the e2e tests: a tool that asks the human a question.
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool(
    defineTool({
      name: "ask_human",
      label: "Ask",
      description: "Ask the human to pick a colour.",
      parameters: Type.Object({}),
      async execute(_id, _params, _signal, _onUpdate, ctx) {
        const choice = await ctx.ui.select("Which colour?", ["red", "green"]);
        return { content: [{ type: "text" as const, text: `the human chose ${choice}` }], details: undefined };
      },
    }),
  );
}
