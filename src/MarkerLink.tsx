type MarkerLinkProps = {
  path: string;
  totalLength: number;
  animate: boolean;
  lineVariant?: "normal" | "dim-10y" | "dim-5y";
};

export function MarkerLink({
  path,
  totalLength,
  animate,
  lineVariant = "normal",
}: MarkerLinkProps) {
  return (
    <path
      d={path}
      className={`timeline-line-path ${animate ? "line-animate" : ""} ${lineVariant && lineVariant !== "normal" ? `line-${lineVariant}` : ""}`}
      style={{
        strokeDasharray: totalLength,
        strokeDashoffset: totalLength,
      }}
    />
  );
}
