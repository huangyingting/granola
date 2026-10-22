import { useEffect, useRef, type ReactNode } from 'react';
import type { Presentation } from '@windows-ai-notes/contracts/presentation';

export function usePresentation<T extends HTMLElement>(
  scope: number,
  id: string,
  marker: Presentation | undefined,
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element || !marker) return;
    let sent = false,
      first = 0,
      second = 0,
      active = true,
      intersecting = false;
    const visible = () => {
      const box = element.getBoundingClientRect();
      return (
        intersecting &&
        document.visibilityState === 'visible' &&
        element.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
          contentVisibilityAuto: true,
        }) &&
        box.width > 0 &&
        box.height > 0 &&
        box.bottom > 0 &&
        box.right > 0 &&
        box.top < window.innerHeight &&
        box.left < window.innerWidth
      );
    };
    const schedule = () => {
      if (!active || sent || first || second || !visible()) return;
      first = requestAnimationFrame(() => {
        first = 0;
        if (!active || !visible()) return;
        second = requestAnimationFrame(() => {
          second = 0;
          if (!active || !visible()) return;
          sent = true;
          void window.notes
            .invoke({
              operation: 'observePresentation',
              scope,
              id,
              token: marker.token,
            })
            .then((response) => {
              if (!response.ok || !('observed' in response))
                console.error('desktop_presentation_acknowledgment_rejected');
            })
            .catch(() =>
              console.error('desktop_presentation_acknowledgment_unavailable'),
            );
        });
      });
    };
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      intersecting = Boolean(
        entry?.isIntersecting &&
        entry.intersectionRect.width > 0 &&
        entry.intersectionRect.height > 0,
      );
      schedule();
    });
    observer.observe(element);
    document.addEventListener('visibilitychange', schedule);
    document.addEventListener('toggle', schedule, true);
    schedule();
    return () => {
      active = false;
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
      observer.disconnect();
      document.removeEventListener('visibilitychange', schedule);
      document.removeEventListener('toggle', schedule, true);
    };
  }, [scope, id, marker?.token]);
  return ref;
}

export function Presented({
  scope,
  id,
  marker,
  children,
}: {
  scope: number;
  id: string;
  marker: Presentation | undefined;
  children: ReactNode;
}) {
  const ref = usePresentation<HTMLSpanElement>(scope, id, marker);
  return (
    <span ref={ref} data-presentation-token={marker?.token}>
      {children}
    </span>
  );
}
