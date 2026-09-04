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
    { name: "og:type", content: "website" },
    { name: "og:title", content: title },
    { name: "og:description", content: description },
  ];

  return tags;
};
