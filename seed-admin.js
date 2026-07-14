name: Seed Admin Passcode

on:
  workflow_dispatch:
    inputs:
      passcode:
        description: 'New admin passcode (min 6 chars)'
        required: true

jobs:
  seed:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install deps
        run: npm install pg bcryptjs

      - name: Run seed script
        env:
          DATABASE_URL: ${{ secrets.DATABASE_URL }}
        run: node seed-admin.js "${{ github.event.inputs.passcode }}"
