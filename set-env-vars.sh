# Fix: ENVIRONMENT = "production" in vars

```bash
curl "https://api.cloudflare.com/client/v4/accounts/ab6cdeed411ce91689e8918e69242c41/workers/scripts/quota-watcher" \
  -H "Authorization: <SECRET_28e62298>" \
  -F "metadata={\"main_module\":\"worker.ts\",\"compatibility_flags\":[],\"compatibility_date\":\"2026-05-24\",\"usage_model\":\"standard\",\"annotations\":{\"workers/message\":\"Set ENVIRONMENT=production\"},\"variables\":{\"ENVIRONMENT\":\"production\"},\"bindings\":[{\"name\":\"AES_GCM_KEY\",\"type\":\"secret_text\"},{\"name\":\"DB\",\"type\":\"d1\",\"database_id\":\"526b46dd-aec4-4275-95dc-4c120c28ace0\"}]}" \
  -F "worker.ts=@worker.ts"
```
