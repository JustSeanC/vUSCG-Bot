# vUSCG Discord Bot

This Discord bot supports operations for the **vUSCG virtual airline**, including user activation, role assignment, mission generation, and more.

---

## 🚀 Features

- Slash command interface with `/activate`, `/promote`, `/mission`, `/location`, etc.
- Water-only mission generation using the **IsItWater API**
- Map preview integration using **Mapbox Static Maps API**
- MySQL integration with **phpVMS** for aircraft and user data
- GeoJSON polygon support for realistic mission bounding areas

---

## ⚙️ Setup Instructions

### 1. Clone the repository
```bash
git clone https://github.com/YOUR_USERNAME/YOUR_REPO_NAME.git
cd YOUR_REPO_NAME
```

### 2. Install dependencies
```bash
npm install
```

### 3. Create your `.env` file
Start by copying the example:
```bash
cp .env.example .env
```

Then edit `.env` and add your actual secrets:
```env
DISCORD_TOKEN=your_discord_bot_token_here
DB_HOST=your_database_host
DB_USER=your_database_user
DB_PASSWORD=your_database_password
DB_NAME=your_database_name
RAPIDAPI_KEY=your_rapidapi_key_for_isitwater
MAPBOX_TOKEN=your_mapbox_token
```

### 4. Start the bot
```bash
node index.js
```

---

## 📁 Project Structure

```
├── index.js              # Main bot logic
├── flavorTexts.json      # Mission flavor templates
├── .env                  # Local environment file (not committed)
├── .env.example          # Template for setup
├── geo_bounds/           # GeoJSON bounding boxes per hub airport
└── api_usage.json        # Tracks daily API usage (IsItWater)
```

---

## 🛑 Important Notes

- **Do not commit your `.env` file**. This contains sensitive credentials.
- If your bot token is exposed publicly, **regenerate it immediately** in the [Discord Developer Portal](https://discord.com/developers/applications).

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
