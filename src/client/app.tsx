import { BrowserRouter, Routes, Route, NavLink } from "react-router-dom";
import { Package, Palette, Wand2, Store } from "lucide-react";
import { BrandKitsView } from "./views/brand-kits";
import { ProductsView } from "./views/products";
import { ProductDetailView } from "./views/product-detail";
import { LaunchDetailView } from "./views/launch-detail";
import { ToolsView } from "./views/tools";

const NAV = [
  { to: "/", label: "Products", icon: Package, end: true },
  { to: "/brands", label: "Brand kits", icon: Palette, end: false },
  { to: "/tools", label: "Image tools", icon: Wand2, end: false },
];

export function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen flex">
        {/* Sidebar */}
        <aside className="w-[220px] shrink-0 border-r border-border bg-surface flex flex-col">
          <div className="h-14 px-4 flex items-center gap-2 border-b border-border">
            <div className="size-7 rounded-lg bg-foreground flex items-center justify-center">
              <Store size={15} className="text-background" />
            </div>
            <span className="font-semibold text-sm">Listing Studio</span>
          </div>
          <nav className="p-3">
            <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted px-2 py-2">Studio</div>
            {NAV.map(({ to, label, icon: Icon, end }) => (
              <NavLink
                key={to}
                to={to}
                end={end}
                className={({ isActive }) =>
                  `flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-[13px] mb-0.5 ${
                    isActive ? "bg-sunken text-foreground font-semibold" : "text-muted hover:bg-sunken"
                  }`
                }
              >
                <Icon size={15} />
                {label}
              </NavLink>
            ))}
          </nav>
          <div className="mt-auto p-4 text-[11px] text-faint leading-relaxed">
            OpenListingStudio
            <br />
            BYOK · open source
          </div>
        </aside>

        {/* Content */}
        <main className="flex-1 min-w-0">
          <Routes>
            <Route path="/" element={<ProductsView />} />
            <Route path="/brands" element={<BrandKitsView />} />
            <Route path="/products/:id" element={<ProductDetailView />} />
            <Route path="/launches/:id" element={<LaunchDetailView />} />
            <Route path="/tools" element={<ToolsView />} />
          </Routes>
        </main>
      </div>
    </BrowserRouter>
  );
}
