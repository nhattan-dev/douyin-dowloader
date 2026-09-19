#!/bin/bash
cd /home/fleex/WorkSpace/Projects/douyind-downloader
export PATH="$HOME/.local/bin:$PATH"
U=MS4wLjABAAAAorJOXedxfQDEGr3bKmbYmzg4Mz0OLOuQPKt8kGYBFxE
for v in 7658103101886434560 7658952596748553508 7660057148440726834; do
  echo "############ $v"
  node --env-file-if-exists=.env scripts/dub-video.mjs --dir "data/$U/$v" --engine v3 --resume 2>&1
done
echo "ALL DONE"
