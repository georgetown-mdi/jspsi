export const seo = ({
  title,
  description,
}: {
  title: string;
  description?: string;
}) => {
  const tags = [
    { title },
    { name: "description", content: description },
    { property: "og:type", content: "website" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
  ];

  return tags;
};
