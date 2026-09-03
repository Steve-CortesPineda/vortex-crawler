async function main() {
  const videoId = 'dQw4w9WgXcQ';

  // Encode params as protobuf-like format that YouTube expects
  // The params field encodes: engagement panel, transcript, video ID
  function encodeTranscriptParams(videoId: string): string {
    // Field 1 (engagement panel ID) = "engagement-panel-searchable-transcript"
    // But the actual encoding is nested protobuf
    // Simpler: use the serialized format that yt-dlp uses
    const innerParam = `\n\x0b${videoId}`;
    const outerParam = `\x1a\r${innerParam}`;
    return Buffer.from(outerParam).toString('base64');
  }

  const params = encodeTranscriptParams(videoId);
  console.log('Params:', params);

  const resp = await fetch('https://www.youtube.com/youtubei/v1/get_transcript', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': '2.20240101.00.00',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en',
        },
      },
      params,
    }),
  });

  console.log('Status:', resp.status);
  const text = await resp.text();
  console.log('Length:', text.length);

  if (text.length > 0) {
    try {
      const data = JSON.parse(text);
      if (data.error) {
        console.log('Error:', data.error.message);
      } else {
        // Navigate to transcript
        const actions = data.actions;
        if (actions) {
          console.log('Actions:', actions.length);
          console.log(JSON.stringify(data).slice(0, 800));
        }
      }
    } catch {
      console.log('Raw:', text.slice(0, 300));
    }
  }
}
main().catch(console.error);
