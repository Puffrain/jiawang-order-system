#!/usr/bin/env bash
set -Eeuo pipefail

# 佳旺订单主站 / 仓库统一登录诊断脚本
# 用法：bash scripts/diagnose-warehouse-login.sh
# 约束：只读检查，不修改 .env、不重启容器、不删除数据。

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

DOMAIN="${CHECK_DOMAIN:-https://www.kunshanjiawang.cn}"
ORIGIN="${CHECK_ORIGIN:-$DOMAIN}"
COMPOSE_ARGS=(--env-file .env -f compose.yaml -f compose.server.yaml)

if [[ ! -f .env ]]; then
  echo "[FAIL] 未找到 .env：$ROOT_DIR/.env"
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[FAIL] 当前环境没有 docker 命令"
  exit 1
fi

if ! docker compose "${COMPOSE_ARGS[@]}" config --quiet >/dev/null 2>&1; then
  echo "[FAIL] Compose 配置校验失败"
  docker compose "${COMPOSE_ARGS[@]}" config --quiet || true
  exit 1
fi

pass=0
warn=0
fail=0

ok() { printf '[ OK ] %s\n' "$*"; pass=$((pass + 1)); }
warning() { printf '[WARN] %s\n' "$*"; warn=$((warn + 1)); }
bad() { printf '[FAIL] %s\n' "$*"; fail=$((fail + 1)); }
section() { printf '\n===== %s =====\n' "$*"; }

check_http() {
  local label="$1" url="$2" method="${3:-GET}"
  local body_file error_file body
  local -a curl_args
  body_file="$(mktemp)"
  error_file="$(mktemp)"
  curl_args=(-sS --max-time 15 -o "$body_file" -w '%{http_code}' -X "$method"
    -H "Origin: $ORIGIN"
    -H "Referer: $DOMAIN/warehouse/login"
    -H 'Content-Type: application/json')
  [[ "$method" == "POST" ]] && curl_args+=(--data '{}')
  HTTP_STATUS="$(curl "${curl_args[@]}" "$url" 2>"$error_file" || true)"
  body="$(tail -c 800 "$body_file" | tr '\n' ' ' | sed 's/[[:space:]]\+/ /g')"
  if [[ "$HTTP_STATUS" =~ ^[0-9]{3}$ && "$HTTP_STATUS" != "000" ]]; then
    printf '%s: HTTP %s\n' "$label" "$HTTP_STATUS"
    [[ -n "$body" ]] && printf '  body: %s\n' "$body"
  else
    printf '%s: 无 HTTP 响应\n  detail: %s\n' "$label" "$(cat "$error_file")"
    HTTP_STATUS=""
  fi
  rm -f "$body_file" "$error_file"
}

section "基础信息"
printf '目录: %s\n域名: %s\nOrigin: %s\n时间: %s\n' "$ROOT_DIR" "$DOMAIN" "$ORIGIN" "$(date -Is)"

section "生产配置（仅显示非敏感值）"
configured_origin="$(sed -n 's/^APP_ORIGIN=//p' .env | tail -n 1 | tr -d '\r')"
if [[ "$configured_origin" == "$ORIGIN" ]]; then
  ok " .env 的 APP_ORIGIN 正确：$configured_origin"
else
  bad " .env 的 APP_ORIGIN 不正确：${configured_origin:-<未设置>}（期望 $ORIGIN）"
fi

for key in SESSION_SECRET APP_MASTER_SECRET APP_MASTER_KEY INTEGRATION_SHARED_SECRET OWNER_PASSWORD; do
  if grep -q "^${key}=." .env; then
    ok "$key 已设置（值已隐藏）"
  else
    warning "$key 未设置或为空"
  fi
done

section "Compose 服务状态"
ps_output="$(docker compose "${COMPOSE_ARGS[@]}" ps 2>&1 || true)"
printf '%s\n' "$ps_output"
for service in order-web warehouse-web warehouse-worker gateway; do
  if printf '%s\n' "$ps_output" | grep -Eq "[[:space:]]${service}[[:space:]]"; then
    ok "$service 已列入 Compose 状态"
  else
    bad "$service 未出现在 Compose 状态中"
  fi
done

section "容器实际 APP_ORIGIN"
for container in jiawang-commerce-order-web-1 jiawang-commerce-warehouse-web-1; do
  if docker inspect "$container" >/dev/null 2>&1; then
    actual="$(docker inspect "$container" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^APP_ORIGIN=//p' | tail -n 1)"
    if [[ "$actual" == "$ORIGIN" ]]; then
      ok "$container：APP_ORIGIN 正确"
    else
      bad "$container：APP_ORIGIN=${actual:-<未设置>}"
    fi
  else
    bad "$container 不存在"
  fi
done

section "外部接口"
check_http '订单健康接口' "$DOMAIN/api/health"
[[ "$HTTP_STATUS" == "200" ]] && ok "订单健康接口正常" || bad "订单健康接口异常"
check_http '仓库健康接口' "$DOMAIN/warehouse/api/health"
[[ "$HTTP_STATUS" == "200" ]] && ok "仓库健康接口正常" || bad "仓库健康接口异常"
check_http '统一登录接口（无浏览器 Cookie）' "$DOMAIN/warehouse/api/v1/auth/order-session" POST
case "$HTTP_STATUS" in
  401) ok "统一登录接口已通过 Origin 校验，未登录时返回 401 属预期" ;;
  403) bad "统一登录接口仍被 403 拒绝，重点检查 APP_ORIGIN / Origin" ;;
  500) bad "统一登录接口返回 500，重点检查订单会话和共享密钥配置" ;;
  *) warning "统一登录接口返回 HTTP ${HTTP_STATUS:-未知}，需要结合响应体判断" ;;
esac
check_http '仓库当前会话接口（无浏览器 Cookie）' "$DOMAIN/warehouse/api/v1/auth/me"
[[ "$HTTP_STATUS" == "401" ]] && ok "当前会话接口无 Cookie 时返回 401 属预期" || warning "当前会话接口返回 HTTP ${HTTP_STATUS:-未知}"

section "最近认证日志（自动过滤常见密钥字段）"
logs="$(docker compose "${COMPOSE_ARGS[@]}" logs --no-color --since=10m --tail=300 warehouse-web order-web gateway 2>&1 || true)"
filtered="$(printf '%s\n' "$logs" | grep -Ei 'auth|session|origin|csrf|forbidden|unauthorized|error|exception|failed|401|403|429|500' || true)"
if [[ -n "$filtered" ]]; then
  printf '%s\n' "$filtered" \
    | sed -E 's/(SESSION_SECRET|APP_MASTER_SECRET|APP_MASTER_KEY|INTEGRATION_SHARED_SECRET|OWNER_PASSWORD|TOKEN|KEY)=([^[:space:]]+)/\1=<redacted>/Ig' \
    | tail -n 160
else
  echo "最近 10 分钟没有匹配到认证错误日志。"
fi

section "结论"
printf '通过: %d  警告: %d  失败: %d\n' "$pass" "$warn" "$fail"
if (( fail > 0 )); then
  echo "请把本脚本输出发回；不要发送 .env、完整容器环境变量或任何密钥。"
  exit 2
fi
if (( warn > 0 )); then
  echo "基础接口和配置未发现硬性失败，请重点查看浏览器 Cookie、登录跳转和上方日志。"
else
  echo "基础检查通过；若浏览器仍显示暂时无法加载，请用无痕窗口重新登录订单后台后再进入仓库。"
fi
