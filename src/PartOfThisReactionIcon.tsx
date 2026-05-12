type PartOfThisReactionIconProps = {
  active: boolean;
};

/** Разметка совпадает с `SVG/Part.svg`; анимация — через классы в `src/styles.css`. */
export function PartOfThisReactionIcon({ active }: PartOfThisReactionIconProps) {
  return (
    <svg
      className={`part-of-this-icon ${active ? "part-of-this-icon--active" : ""}`}
      width="28"
      height="32"
      viewBox="0 0 64 72"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      preserveAspectRatio="xMidYMid meet"
    >
      <path
        className="part-of-this-icon__body"
        d="M20.43 28.21 A18 18 0 1 0 43.57 28.21"
      />
      <path className="part-of-this-icon__slot" d="M20.43 28.21 L32 42 L43.57 28.21" />
      <g className="part-of-this-icon__sector-group">
        <path
          className="part-of-this-icon__sector"
          d="M20.43 28.21 A18 18 0 0 1 43.57 28.21 L32 42 Z"
        />
      </g>
    </svg>
  );
}
