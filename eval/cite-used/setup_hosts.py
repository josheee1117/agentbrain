"""给 home-on/home-off 写 Claude Code、Codex、opencode 的最小配置：只有 agentbrain hook/插件 + 模型。
密钥不复制：Claude 走钥匙串（Library/Keychains 软链），Codex 软链 auth.json，opencode 用 OPENCODE_CONFIG 指向真实配置文件（只读）。"""
import json, os
R='/private/tmp/cite-eval'; NODE='/opt/homebrew/bin/node'; CLI=f'{R}/agentbrain/src/cli.ts'; U='/Users/hejiayuan'
def ab(cond, args):  # Codex 会过滤自定义环境变量：AB_HOME 等直接写进命令
    return f'AB_HOME={R}/abhome-{cond} AB_REGISTRY={R}/registry {NODE} {CLI} {args}'
for cond in ('on','off'):
    H=f'{R}/home-{cond}'
    # Claude Code
    s={'model':'opus','hooks':{
        'UserPromptSubmit':[{'hooks':[{'type':'command','command':ab(cond,'recall --hook'),'timeout':5},{'type':'command','command':ab(cond,'capture --hook --host claude'),'timeout':5}]}]}}
    json.dump(s,open(f'{H}/.claude/settings.json','w'),indent=1)
    if not os.path.exists(f'{H}/.claude.json'):
        c=json.load(open(f'{U}/.claude.json'))
        json.dump({k:c[k] for k in ('oauthAccount','hasCompletedOnboarding','userID') if k in c},open(f'{H}/.claude.json','w'))
    # Codex
    os.makedirs(f'{H}/.codex',exist_ok=True)
    open(f'{H}/.codex/config.toml','w').write('''model = "gpt-5.6-sol"
model_provider = "custom"
model_reasoning_effort = "xhigh"
approval_policy = "never"
sandbox_mode = "danger-full-access"

[features]
hooks = true

[model_providers.custom]
name = "OpenAI"
requires_openai_auth = true
supports_websockets = true
wire_api = "responses"
''')
    if not os.path.lexists(f'{H}/.codex/auth.json'): os.symlink(f'{U}/.codex/auth.json',f'{H}/.codex/auth.json')
    json.dump({'hooks':{'UserPromptSubmit':[{'hooks':[{'type':'command','command':ab(cond,'recall --hook'),'timeout':5},{'type':'command','command':ab(cond,'capture --hook --host codex'),'timeout':5}]}]}},open(f'{H}/.codex/hooks.json','w'),indent=1)
    # opencode：插件拷一份，把写死的 ab 换成临时检出；AB_HOME 由进程环境传
    os.makedirs(f'{H}/.config/opencode/plugins',exist_ok=True)
    src=open(f'{R}/agentbrain/integrations/opencode/agentbrain-v2.js').read()
    assert 'const AB = "/Users/hejiayuan/.local/bin/ab";' in src
    open(f'{H}/.config/opencode/plugins/agentbrain-v2.js','w').write(src.replace('const AB = "/Users/hejiayuan/.local/bin/ab";',f'const AB = "{CLI}";'))
print('ok')
