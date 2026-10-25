#!/usr/bin/env bash
# Intentional strict idempotent re-import: do not write to PROD and never touch ELO.
set -Eeuo pipefail
[[ "${DB_TABLE_PREFIX:-}" == "bd_test_" ]] || { echo "TEST only" >&2; exit 1; }
manifest=infra/atlas/manifests/grandprix-dido-2026-10-24.json
external=UBKzQpfMMwyB
base=https://test.blindleiadarts.ingenting.org
mkdir -p /tmp/dido-idempotent/matches
curl -fsSL --connect-timeout 8 --max-time 160 "$base/api/atlas-tournament-probe.php?tournament=$external" -o /tmp/dido-idempotent/source.json
php -r '
$m=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
$d=json_decode(file_get_contents($argv[2]),true,512,JSON_THROW_ON_ERROR);
if(($d["ok"]??false)!==true||($d["tournament_external_id"]??"")!=="UBKzQpfMMwyB")exit(1);
foreach($m["groups"] as $g)if(array_keys($d["pages"]["group-".$g["number"]]["matches"]??[])!==$g["match_ids"])exit(1);
if(array_keys($d["pages"]["results"]["matches"]??[])!==$m["playoff"]["match_ids"])exit(1);
' "$manifest" /tmp/dido-idempotent/source.json
mapfile -t ids < <(php -r '$m=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);foreach($m["groups"] as $g)foreach($g["match_ids"] as $id)echo $id,"\n";foreach($m["playoff"]["match_ids"] as $id)echo $id,"\n";' "$manifest")
[[ "${#ids[@]}" == 79 ]] || exit 1
for id in "${ids[@]}"; do
  ok=no
  for attempt in 1 2 3 4; do
    status="$(curl -sSL --connect-timeout 8 --max-time 100 -o "/tmp/dido-idempotent/matches/${id}.json" -w '%{http_code}' "$base/api/atlas-match-visits.php?match=$id" || true)"
    if [[ "$status" == 200 ]] && php -r '$d=json_decode(file_get_contents($argv[1]),true);exit(($d["ok"]??false)===true&&($d["external_id"]??"")===$argv[2]&&($d["leg_count"]??0)>0?0:1);' "/tmp/dido-idempotent/matches/${id}.json" "$id"; then ok=yes;break;fi
    sleep $((30+attempt*20))
  done
  [[ "$ok" == yes ]] || { echo "Match detail unavailable: $id" >&2; exit 1; }
  sleep 12
done
php -r '
$m=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
$ids=[];foreach($m["groups"] as $g)foreach($g["match_ids"] as $x)$ids[]=$x;foreach($m["playoff"]["match_ids"] as $x)$ids[]=$x;
$legs=0;foreach($ids as $x){$d=json_decode(file_get_contents("/tmp/dido-idempotent/matches/{$x}.json"),true,512,JSON_THROW_ON_ERROR);$legs+=(int)$d["leg_count"];}
if($legs!==88)throw new RuntimeException("Detail mismatch on second pass: {$legs}");
' "$manifest"
php infra/sql/import_atlas_grandprix_dido_test.php "$manifest" /tmp/dido-idempotent/source.json
for id in "${ids[@]}"; do php infra/sql/import_atlas_match_visits_test.php "$manifest" "/tmp/dido-idempotent/matches/${id}.json"; done
php infra/sql/atlas_history_verify.php --external="$external" --expected-matches=79 --expected-players=18 --phase=data --require-visits=1 --require-playoff=1
php infra/sql/atlas_history_finalize.php --external="$external"
php infra/sql/atlas_history_verify.php --external="$external" --expected-matches=79 --expected-players=18 --phase=final --require-visits=1 --require-playoff=1
php infra/sql/atlas_history_lifecycle_verify.php --external="$external"
php infra/sql/atlas_format_metadata_verify.php --external="$external"
echo "DIDO_TEST_IDEMPOTENT_79_MATCHES_OK=yes"
