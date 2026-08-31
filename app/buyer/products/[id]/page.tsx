import ProductDetail from "@/components/buyer/product-detail";

export default async function BuyerProductPage({params}:{params:Promise<{id:string}>}){const{id}=await params;return <ProductDetail productId={id}/>}
