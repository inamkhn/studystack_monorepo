import type { MetadataRoute } from "next";

import { SITE_URL } from "@/lib/site";

/** Metadata route — Next serves this at /robots.txt. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: ["/dashboard/", "/api/"] }],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
