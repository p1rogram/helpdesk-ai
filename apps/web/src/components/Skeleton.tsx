/** AI: Placeholder rows while a list loads - keeps the layout from jumping. */
export function SkeletonList({ rows = 4 }: { rows?: number }) {
  return (
    <div className="list" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="item" style={{ cursor: 'default' }}>
          <div
            className="skeleton"
            style={{ width: 38, height: 38, borderRadius: 11, flex: '0 0 auto' }}
          />
          <div className="body">
            <div
              className="skeleton"
              style={{ height: 13, width: `${60 + ((i * 13) % 30)}%`, marginBottom: 8 }}
            />
            <div className="skeleton" style={{ height: 10, width: '40%' }} />
          </div>
        </div>
      ))}
    </div>
  );
}
