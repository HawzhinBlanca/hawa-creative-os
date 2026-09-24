import React from 'react';
import { useAuthorizedImage } from '../services/authorizedImage.js';

export interface AuthorizedImageProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  /** A Core address (/v1/...), or a data: or blob: URL. */
  src?: string | null;
  /** Shown while the picture loads, and when it could not be fetched. */
  fallback?: React.ReactNode;
}

/**
 * An <img> for a picture Core serves behind sign-in (services/authorizedImage.ts): fetched with the
 * session's header, shown from an object URL.
 */
export const AuthorizedImage: React.FC<AuthorizedImageProps> = ({ src, fallback = null, ...img }) => {
  const image = useAuthorizedImage(src);
  if (!image.src) return <>{fallback}</>;
  return <img {...img} src={image.src} />;
};
