interface SparklineProps {
  points: number[];
  width?: number;
  height?: number;
  color?: string;
  fill?: boolean;
  className?: string;
}

export function Sparkline({
  points,
  width = 80,
  height = 32,
  color = "#635bff",
  fill = true,
  className,
}: SparklineProps) {
  if (!points || points.length < 2) return null;

  const min = Math.min(...points);
  const max = Math.max(...points);
  const range = max - min || 1;
  const pad = 2;

  const xs = points.map((_, i) => pad + (i / (points.length - 1)) * (width - pad * 2));
  const ys = points.map((v) => pad + (1 - (v - min) / range) * (height - pad * 2));

  const line = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  const area = `${line} L${xs[xs.length - 1].toFixed(1)},${(height - pad).toFixed(1)} L${xs[0].toFixed(1)},${(height - pad).toFixed(1)} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      {fill && (
        <path d={area} fill={color} fillOpacity={0.12} />
      )}
      <path d={line} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
