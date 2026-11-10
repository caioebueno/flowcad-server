# Running the self-hosted model on Vast.ai

How to start the Vast.ai GPU instance that serves Keel's self-hosted model
(Qwen3.8-27B FP8 on vLLM) and connect it to this server. For how the server
routes turns to it, see [Self-hosted model](../README.md#self-hosted-model) in the README.

The short version, once everything is set up:

1. In Vast.ai, open **Instances** and click **Start** on the instance.
2. Wait about 3 to 5 minutes, until **Instance Logs** shows `Application startup complete`.
3. Use Keel. Turns go to the GPU, and to Claude whenever it's off.
4. Click **Stop** when you're done for the day.

The rest of this page covers first-time setup, checking it works, and fixing
common problems.

## How the pieces fit

```
Keel (Mac) ──> flowcad-server (Railway) ──> http://<instance ip>:<port>  ──> Caddy (token check) ──> vLLM on 127.0.0.1:18000
                         │
                         └──> Claude, if the instance is off or doesn't answer within 20 seconds
```

Vast.ai's **vLLM** template runs vLLM inside the instance on `127.0.0.1:18000` and
puts the portal's Caddy proxy in front of it on port `8000`, protected by the
portal token. Vast.ai maps that `8000` to a random external port on the
instance's public IP. That external address and the token are what this server
uses (`SELF_HOSTED_BASE_URL` and `SELF_HOSTED_TOKEN`).

## First-time setup

### 1. Pick a GPU

You need 48 GB of GPU memory: the FP8 model takes about 29 GB, and the rest is
for a 64K context. Good choices, all around $0.40 to $0.75 an hour:

| GPU | Notes |
| --- | --- |
| **RTX PRO 5000 (48 GB)** | What we use now. New Blackwell card with native FP8 |
| **L40S / L40 (48 GB)** | Native FP8, just as good |
| **RTX A6000 / A40 (48 GB)** | Older and slower, no native FP8 (use an AWQ 4-bit build instead) |

Skip these:

- **CMP 170HX**: crypto-mining cards with slow PCIe 2.0 and cut-down compute.
- **"48 GB RTX 4090"**: real 4090s have 24 GB, so these are modified cards.
- Anything under 32 GB.

When choosing a listing, pick **on-demand** (not interruptible), a **verified**
host with **reliability above 98%**, and fast internet, since the model download
is about 28 GB.

### 2. Set up the template

1. Go to **Templates**, find the plain **vLLM** template (not vLLM Omni), and
   click the **pencil** to edit it. Vast.ai saves your edit under **My Templates**.
2. Set these fields:
   - `VLLM_MODEL`:
     ```
     Qwen/Qwen3.8-27B-FP8
     ```
   - `VLLM_ARGS`:
     ```
     --max-num-seqs 8 --max-model-len 65536 --kv-cache-dtype fp8 --gpu-memory-utilization 0.92 --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 --download-dir /workspace/models --host 127.0.0.1 --port 18000 --speculative-config {"method":"mtp","num_speculative_tokens":3} --default-chat-template-kwargs {"enable_thinking":false}
     ```
   - **Disk Space (Container Size)**: `100` GB.
3. Keep `--host 127.0.0.1 --port 18000` as they are, so the portal's
   **vLLM API** card and token protection keep working.

What the flags do:

- `--tool-call-parser qwen3_coder --reasoning-parser qwen3`: read Qwen's tool
  calls and thinking into the Anthropic Messages format Keel uses.
- `--speculative-config ... mtp`: multi-token prediction, which uses the model's
  small draft head to roughly double output speed (about 37 to 90 tokens a
  second) with the same output.
- `--default-chat-template-kwargs {"enable_thinking":false}`: thinking is off
  unless a request turns it on. This server turns it on per task type
  (`thinkingUpdates` in the self-hosted profiles), so chat stays fast.

After the first start, check that vLLM accepted the last two flags: the
`non-default args` line in the log should list `speculative_config` and
`default_chat_template_kwargs`. If it doesn't, or vLLM fails to parse them,
start vLLM by hand instead (see [Start vLLM by hand](#start-vllm-by-hand)).

### 3. Rent the instance

1. On **Search**, select your edited template and make sure the **Disk Space To
   Allocate** slider shows **100 GB**. Disk can't be changed after renting, and
   the default (about 24 GB) is too small for this model.
2. Filter for 1x of a GPU from the list above, and click **Rent**.
3. On **Instances**, wait until it's running, then click **Open** to reach the
   instance portal.
4. Open **Instance Logs**. The first start downloads about 28 GB and takes about
   10 minutes. Wait for `Application startup complete`.

You can watch the download from **Jupyter Terminal** with `du -sh /workspace/models`.
A warning that `HF_TOKEN` isn't set only means slower downloads, and a warning
about "no registered multimodal processor" or FP8 KV-cache scales is harmless.

### 4. Connect it to this server

1. **Base URL.** On the instance card, click the **IP** button (IP & ports). Find
   the line ending in `-> 8000/tcp`, for example `203.0.113.5:41234 -> 8000/tcp`.
   The base URL is `http://203.0.113.5:41234`, with no `/v1` at the end.
2. **Token.** In the portal's **Jupyter Terminal**, run:
   ```sh
   echo $OPEN_BUTTON_TOKEN
   ```
3. **Check both from your Mac:**
   ```sh
   curl -i http://<ip>:<port>/v1/models -H "Authorization: Bearer <token>"
   ```
   A `200` with JSON listing `Qwen/Qwen3.8-27B-FP8` means both are right. A
   `302`, `401` or an HTML login page means the token is wrong.
4. **Railway.** On the app service's **Variables** tab, set
   `SELF_HOSTED_BASE_URL` and `SELF_HOSTED_TOKEN` to those two values. Railway
   redeploys by itself. Leaving `SELF_HOSTED_BASE_URL` empty means Claude only.
5. **Remote config.** The built-in defaults already include the `selfHosted`
   section. If a config has been published to `config_versions`, it needs one too:
   ```sh
   npm run config -- show > live.json
   # copy the selfHosted block and the "self:Qwen/Qwen3.8-27B-FP8" price
   # from `npm run config -- defaults` into live.json
   npm run config -- publish live.json "self-hosted primary"
   ```
6. Send a message in Keel's agent pane. In the Railway logs, the `turn` line
   should show model `self:Qwen/Qwen3.8-27B-FP8`.

Keep the token out of commits, chats and screenshots. The portal's
`trycloudflare.com` link is public too, and changes on every restart, so don't
use it as the base URL.

## Every day

**Start:** **Instances** > **Start**. The model is already on the disk, so it
takes about 3 to 5 minutes. Wait for `Application startup complete` in
**Instance Logs** (or `tail -n 20 /workspace/vllm.log` if you started vLLM by
hand).

**Check it's serving** (in the Jupyter Terminal):

```sh
curl -s localhost:18000/v1/messages -H "content-type: application/json" \
  -d '{"model":"Qwen/Qwen3.8-27B-FP8","max_tokens":200,"messages":[{"role":"user","content":"hi"}]}'
```

You should get JSON back with a `text` block and no `thinking` block.

**Stop:** **Instances** > **Stop**. Stopping keeps the model on the disk, so you
only pay for storage (about $0.30 a day). **Destroy** deletes the disk, and a
new instance gets a new IP and port, so you'd have to update
`SELF_HOSTED_BASE_URL` on Railway.

While the instance is stopped, the server waits up to 20 seconds for it on each
turn and then uses Claude. To skip that wait, clear `SELF_HOSTED_BASE_URL` on
Railway, or set `selfHosted.enabled` to `false` in remote config.

## Start vLLM by hand

Use this if the template's arguments didn't stick, or you want to change flags
without recreating the instance. A hand-started vLLM doesn't come back after
the instance restarts.

In the Jupyter Terminal:

```sh
# 1. Stop the template's vLLM and anything left over
supervisorctl stop vllm
pkill -f "vllm serve"; sleep 5
ps aux | grep "vllm serve" | grep -v grep   # should print nothing
nvidia-smi                                  # memory should be near 0 MiB
ss -ltnp | grep 18000                       # should print nothing

# 2. Start it
nohup vllm serve Qwen/Qwen3.8-27B-FP8 --max-num-seqs 8 --max-model-len 65536 \
  --kv-cache-dtype fp8 --gpu-memory-utilization 0.92 \
  --enable-auto-tool-choice --tool-call-parser qwen3_coder --reasoning-parser qwen3 \
  --download-dir /workspace/models --host 127.0.0.1 --port 18000 \
  --speculative-config '{"method":"mtp","num_speculative_tokens":3}' \
  --default-chat-template-kwargs '{"enable_thinking": false}' \
  > /workspace/vllm.log 2>&1 &

# 3. Check the log every minute or so until "Application startup complete"
tail -n 20 /workspace/vllm.log
```

Use `tail -n 20` rather than `tail -f`: in the Jupyter Terminal, Ctrl+C
sometimes doesn't stop `tail -f`. If a terminal gets stuck, open a new one from
**Jupyter** > **File** > **New** > **Terminal**.

To debug what the model sends, add `--enable-log-requests --enable-log-outputs`.
The log stays on the instance.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `df -h /workspace` shows about 24 GB, or the download fails for lack of space | Disk is fixed at rent time. Destroy the instance and rent a new one with 100 GB |
| Log shows a different model (for example `Qwen/Qwen3.5-9B`) | The template wasn't edited. Check with `env \| grep -i vllm`, then fix `VLLM_MODEL` and `VLLM_ARGS`, or start vLLM by hand |
| `OSError: [Errno 98] Address already in use` | The old vLLM still holds port 18000. Run the stop steps in [Start vLLM by hand](#start-vllm-by-hand), using `pkill -9 -f "vllm serve"` if needed |
| `CUDA out of memory` at startup | Lower `--max-model-len` (for example to `32000`), or use a 48 GB card |
| Keel spins for minutes on a simple message | Thinking is on by default. Check the `non-default args` log line for `enable_thinking: False` |
| `curl` to `/v1/models` from the Mac fails | Check the IP and external port for `8000/tcp`, and the token from `echo $OPEN_BUTTON_TOKEN` |
| Turns show Claude models in the Railway logs | The instance is off, vLLM is still loading, the variables are missing, or the published config has no `selfHosted` section |
