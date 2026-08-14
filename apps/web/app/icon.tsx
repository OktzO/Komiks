import { ImageResponse } from 'next/og';

export const size = { width: 32, height: 32 };
export const contentType = 'image/svg+xml';
export const runtime = 'edge';

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0a0a0a',
          color: '#fafafa',
          fontSize: 20,
          fontWeight: 800,
          borderRadius: 6,
        }}
      >
        M
      </div>
    ),
    size
  );
}
