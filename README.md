vUSCG Discord Bot

This Discord bot supports operations for the vUSCG virtual airline, including user activation, role assignment, mission generation, and more.

Features

Slash command interface with /activate, /promote, /mission, /location, and more

Water-only mission generation using the IsItWater API

Map preview with Mapbox for missions

MySQL database integration with phpVMS

GeoJSON polygon support for realistic AOI boundaries

Setup Instructions

Clone the repository
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME

Install dependencies
npm install

Create a .env file
Copy the example file:
cp .env.example .env

Then edit .env and add your actual secrets:
DISCORD_TOKEN=your_discord_bot_token_here
DB_HOST=your_database_host
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_NAME=your_database_name
RAPIDAPI_KEY=your_rapidapi_key_for_isitwater
MAPBOX_TOKEN=your_mapbox_token

Start the bot
node index.js

Project Structure

index.js — Main bot logic and command handling

geo_bounds/ — GeoJSON files defining search areas per airport

flavorTexts.json — Mission text templates

.env — Environment variables (not committed)

.env.example — Shared template for setup

Important

Do not commit your .env file
Keep secrets out of version control. .env is already in .gitignore.

Reset your bot token immediately if it is exposed
You can regenerate your token in the Discord Developer Portal.

License

MIT License
