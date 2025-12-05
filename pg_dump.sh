#!/bin/zsh

pg_dump \
  --format=custom \
  --no-owner \
  --no-acl \
  --dbname="postgresql://mjh2241:NhJF5nbex43eeFstnILtykbSl637eOVE@dpg-d0dpis24d50c7381vi60-a.virginia-postgres.render.com/rhythmanalysis" \
  --file=rhythmanalysis.dump
