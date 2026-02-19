type MarkerLinkProps = {
  path: string;
  totalLength: number;
  animate: boolean;
};

export function MarkerLink({ path, totalLength, animate }: MarkerLinkProps) {
  return (
    <path
      d={path}
      className={`timeline-line-path ${animate ? "line-animate" : ""}`}
      style={{
        strokeDasharray: totalLength,
        strokeDashoffset: totalLength,
      }}
    />
  );
}
