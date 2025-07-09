# Retell AI Dashboard

A modern, comprehensive dashboard for managing and monitoring Retell AI voice agent calls.

## Features

- **Call Management**: View, sort, and filter incoming and historical calls
- **Detailed Call Views**: Access full transcripts and audio playbacks
- **Real-time Data**: Live integration with Retell AI API
- **Modern UI**: Clean, responsive interface built with Material UI
- **Search & Filter**: Efficient call management capabilities
- **Analytics**: Basic visual analytics for call trends and sentiment

## Tech Stack

- **Frontend**: React.js with Material UI
- **Backend**: Node.js with Express.js
- **API Integration**: Retell AI REST API

## Quick Start

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn

### Installation

1. Clone the repository
2. Install dependencies:
   ```bash
   npm run install:all
   ```

3. Set up environment variables:
   - Copy `backend/.env.example` to `backend/.env`
   - Add your Retell AI API key

4. Start the development server:
   ```bash
   npm run dev
   ```

The dashboard will be available at `http://localhost:3000`

## Environment Variables

Create a `.env` file in the `backend` directory:

```
RETELL_API_KEY=your_retell_api_key_here
PORT=5000
NODE_ENV=development
```

## Deployment

### Local Deployment

```bash
npm run build
npm start
```

### Cloud Deployment

The application is ready for deployment on:
- Vercel (recommended for frontend)
- Heroku (for full-stack)
- AWS
- Railway

## API Endpoints

- `GET /api/calls` - Fetch all calls
- `GET /api/calls/:id` - Get specific call details
- `GET /api/calls/:id/transcript` - Get call transcript
- `GET /api/calls/:id/audio` - Get call audio URL

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License 