# Strata for vLLM

A small local dashboard for [vLLM](https://github.com/vllm-project/vllm) inference servers,
inspired by [Strata](https://github.com/Niko1221/Strata) by Niko1221 (MIT).

Dark, card-based monitor showing in real time (1 s refresh):

- **Model state** — idle / reading prompt / generating / queued, with KV-cache fill
- **Speed** — live decode (tok/s), falls back to prefill rate or last request
- **GPU** — utilization, VRAM, temperature, power, PCIe generation + live bandwidth
- **Host** — CPU, system RAM, disk read/write
- **Context fill** — KV cache gauge, RAM, temperature, prefix-cache reuse
- **Recent requests** — per-request prompt/output tokens, tok/s, duration

The vLLM endpoint (and an optional API key) are entered in the UI (top-right ⚙) and
persisted in the container's data volume.

## How it works

- `server.py` — FastAPI app. Samples every second:
  - GPU stats via **NVML** (the container needs `--gpus all` and the NVIDIA runtime)
  - vLLM stats from `/v1/models`, `/v1/version` and `/metrics` (Prometheus text)
  - host stats from `/proc` + psutil
- `web/` — static UI (no framework), polls `GET /api/metrics` once per second
- `POST /api/settings` — save `{ "backend": "http://host:8000", "key": "…" }` to `DATA_DIR/config.json`

## Run with Docker

```sh
docker run -d --name strata-vllm \
  --gpus all \
  -p 8377:8377 \
  -v /mnt/user/appdata/strata-vllm:/app/data \
  vldmarton/strata-vllm
```

Then open <http://localhost:8377> and set the backend URL in Settings,
e.g. `http://192.168.0.106:8000`.

> The dashboard talks to the vLLM server **directly** (browser → server → vLLM is
> not involved — the *container* polls vLLM). Use the LAN address of the vLLM host,
> not `localhost`, unless vLLM runs in this same container.

## Development

```sh
pip install -r requirements.txt
python server.py            # http://localhost:8377
```

## Unraid

Create a container from the repository (`docker run` above) or a template with:
`Network: bridge` (`br0`), port `8377:8377`, GPU `all`, and the data volume
`/mnt/user/appdata/strata-vllm:/app/data`.
