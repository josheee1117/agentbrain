// 评测用：加载临时检出的 Pi 扩展，但让它调临时检出的 cli.ts（原扩展写死了 ~/.local/bin/ab）。
import { createExtension, makeExecRunner } from "/private/tmp/cite-eval/agentbrain/integrations/pi/agentbrain-recall.ts";
export default createExtension(makeExecRunner(["/opt/homebrew/bin/node", ["/private/tmp/cite-eval/agentbrain/src/cli.ts"]]));
