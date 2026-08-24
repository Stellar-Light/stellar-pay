# The hosted sandbox seller

A real HTTP 402 on **Stellar testnet** anyone can pay with play money — the
"try it" shelf for stellar-pay. Currency is **native XLM** via its SAC, so a
friendbot-funded wallet can pay immediately: no trustline, no faucet, no USDC.
Fees are sponsored by the seller.

## Run locally

```sh
SELLER_SECRET_KEY=S... npx tsx sandbox-server/server.ts
# then, from another shell:
npx stellar-pay setup --sandbox
STELLAR_PAY_ALLOW_PRIVATE=1 npx stellar-pay curl http://127.0.0.1:8787/data --yes --sandbox
```

`SELLER_SECRET_KEY` is any friendbot-funded testnet key — it receives the
payments and sponsors the network fees.

## Deploy (fly.io)

```sh
fly launch --no-deploy --copy-config --name stellar-pay-sandbox --path sandbox-server
fly secrets set SELLER_SECRET_KEY=S...
fly deploy
```

One always-on machine, on purpose: the MPP challenge store is in-memory, so
challenges must be issued and redeemed by the same process.

## Endpoints

| Path | Cost | What |
|---|---|---|
| `/` | free | what this is + how to pay it |
| `/health` | free | liveness |
| `/data` | 0.001 XLM | the canonical paid call |
| `/quote` | 0.001 XLM | a JSON payload worth parsing |

Every payment settles on-chain — the response trailer carries the
stellar.expert link.
