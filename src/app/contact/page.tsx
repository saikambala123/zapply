import Nav from "@/components/marketing/Nav";
import Footer from "@/components/marketing/Footer";
import ContactForm from "@/components/marketing/ContactForm";

// Set NEXT_PUBLIC_SUPPORT_EMAIL to your real inbox — the page shipped with a
// placeholder address that went nowhere.
const SUPPORT_EMAIL = process.env.NEXT_PUBLIC_SUPPORT_EMAIL || "support@zapply.app";

export const metadata = { title: "Contact" };

export default function ContactPage() {
  return (
    <>
      <Nav />
      <main className="container-x max-w-[640px] py-16">
        <p className="eyebrow">Contact</p>
        <h1 className="mt-3 font-display text-[36px] font-extrabold tracking-[-.02em]">Get in touch</h1>
        <p className="mt-4 text-[16px] leading-relaxed text-ink-soft">
          Found a site where autofill misses fields? Send the job link — adapters get written from real
          examples, so a broken form is the most useful thing you can report.
        </p>

        <ContactForm to={SUPPORT_EMAIL} />
      </main>
      <Footer />
    </>
  );
}
