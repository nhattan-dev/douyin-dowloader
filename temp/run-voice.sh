#!/bin/bash
cd /home/fleex/WorkSpace/Projects/douyind-downloader
export PATH="$HOME/.local/bin:$PATH"
U=MS4wLjABAAAAorJOXedxfQDEGr3bKmbYmzg4Mz0OLOuQPKt8kGYBFxE
for v in 7658103101886434560 7658952596748553508 7660057148440726834; do
  d="data/$U/$v"
  spk=$(node -e 'const j=require("./"+process.argv[1]+"/transcript.json");console.log([...new Set(j.segments.map(s=>s.speaker).filter(Boolean))].join("\n"))' "$d")
  while IFS= read -r s; do
    [ -z "$s" ] && continue
    echo "=== $v / $s"
    node scripts/extract-voice.js --dir "$d" --speaker "$s" 2>&1 | tail -8
  done <<< "$spk"
done
echo "ALL DONE"
